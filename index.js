import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync } from 'child_process'

export default class ServerlessBunPlugin {
  constructor(serverless, options) {
    this.serverless = serverless
    this.options = options
    this.log = serverless.cli || console

    let customBun = this.serverless.service.custom.bun
    this.bunVersion = 'latest'

    if (customBun) {
      this.bunVersion = customBun.version
    }

    this.pluginPath = path.dirname(new URL(import.meta.url).pathname)
    this.dockerPath = path.join(this.serverless.config.servicePath, '.serverless', 'docker')

    this.hooks = {
      'before:package:initialize': this.setupBunRuntime.bind(this),
      'before:deploy:function:initialize': this.setupSingleFunction.bind(this),
      'after:package:finalize': this.cleanup.bind(this),
      'before:invoke:local:invoke': this.invokeLocal.bind(this),
    }
  }

  async invokeLocal() {
    const functionName = this.options.function
    const fn = this.serverless.service.functions[functionName]

    if (!fn) {
      throw new Error(`Function ${functionName} not found`)
    }

    const runtime = fn.runtime || this.serverless.service.provider.runtime
    if (!runtime || !runtime.startsWith('bun:1')) {
      return
    }

    const handlerParts = fn.handler.split('.')
    const handlerFile = handlerParts.slice(0, -1).join('.')

    const eventData = this.options.data || '{}'
    const eventPath = this.options.path

    let event = eventData

    if (eventPath) {
      event = fs.readFileSync(eventPath, 'utf-8')
    }

    const servicePath = this.serverless.config.servicePath
    const handlerFullPath = path.join(servicePath, `${handlerFile}.ts`)

    const invokeScript = `
import handler from '${handlerFullPath}';

const event = ${event};
const context = { awsRequestId: 'local-${Date.now()}', functionName: '${functionName}' };
const result = await handler(event, context);
console.log(JSON.stringify(result, null, 2));
`

    const tempFile = path.join(os.tmpdir(), `sls-bun-invoke-${Date.now()}.ts`)

    try {
      fs.writeFileSync(tempFile, invokeScript)

      execSync(`bun ${tempFile}`, {
        stdio: 'inherit',
        cwd: this.serverless.config.servicePath,
      })
    } catch (e) {
      process.exit(1)
    } finally {
      fs.unlinkSync(tempFile)
    }

    process.exit(0)
  }

  async setupBunRuntime() {
    const service = this.serverless.service
    const functions = service.functions

    for (const [name, fn] of Object.entries(functions)) {
      const runtime = fn.runtime || service.provider.runtime

      if (!runtime || !runtime.startsWith('bun:1')) {
        continue
      }

      this.log.log(`bun: configuring ${name} for Docker deployment`)

      const arch = fn.architecture || service.provider.architecture || 'x86_64'

      this.generateDockerfile(name, fn, arch)

      delete fn.runtime
      delete fn.handler

      fn.image = {
        name: `bun-${name}`,
      }
    }

    service.provider.ecr = service.provider.ecr || {}
    service.provider.ecr.images = service.provider.ecr.images || {}

    for (const [name, fn] of Object.entries(functions)) {
      if (fn.image && fn.image.name) {
        service.provider.ecr.images[fn.image.name] = {
          path: path.join('.serverless', 'docker', name),
          platform: fn.architecture === 'arm64' ? 'linux/arm64' : 'linux/amd64',
        }
      }
    }
  }

  async setupSingleFunction() {
    const functionName = this.options.function
    const service = this.serverless.service
    const fn = service.functions[functionName]

    if (!fn) return

    const runtime = fn.runtime || service.provider.runtime

    if (!runtime || !runtime.startsWith('bun:1')) {
      return
    }

    this.log.log(`bun: configuring ${functionName} for Docker deployment`)

    const arch = fn.architecture || service.provider.architecture || 'x86_64'

    this.generateDockerfile(functionName, fn, arch)

    delete fn.runtime
    delete fn.handler

    fn.image = {
      name: `bun-${functionName}`,
    }

    service.provider.ecr = service.provider.ecr || {}
    service.provider.ecr.images = service.provider.ecr.images || {}
    service.provider.ecr.images[fn.image.name] = {
      path: path.join('.serverless', 'docker', functionName),
      platform: arch === 'arm64' ? 'linux/arm64' : 'linux/amd64',
    }
  }

  generateDockerfile(name, fn, arch) {
    const servicePath = this.serverless.config.servicePath
    const functionDockerPath = path.join(this.dockerPath, name)

    fs.mkdirSync(functionDockerPath, { recursive: true })

    const handlerParts = fn.handler.split('.')
    const handlerFile = handlerParts.slice(0, -1).join('.')
    const handlerMethod = handlerParts[handlerParts.length - 1]
    const handlerDir = path.dirname(handlerFile)

    const dockerfile = `FROM oven/bun:${this.bunVersion} AS builder

WORKDIR /build

COPY package.json bun.lock* ./
RUN bun install

FROM public.ecr.aws/lambda/provided:al2023

WORKDIR /var/task

COPY --from=builder /usr/local/bin/bun /usr/local/bin/bun
COPY --from=builder /build/node_modules ./node_modules
COPY . ./${handlerDir}/
COPY runtime.js ./

RUN chmod +x /usr/local/bin/bun

ENV HOME=/tmp
ENV TMPDIR=/tmp
ENV BUN_INSTALL_CACHE_DIR=/tmp/.bun-cache

ENTRYPOINT ["/usr/local/bin/bun", "run", "/var/task/runtime.js"]
`

    fs.writeFileSync(path.join(functionDockerPath, 'Dockerfile'), dockerfile)

    this.generateRuntimeJs(functionDockerPath, handlerFile, handlerMethod)

    const srcPackageJson = path.join(servicePath, 'package.json')
    if (fs.existsSync(srcPackageJson)) {
      fs.copyFileSync(srcPackageJson, path.join(functionDockerPath, 'package.json'))
    }

    const srcBunLock = path.join(servicePath, 'bun.lock')
    if (fs.existsSync(srcBunLock)) {
      fs.copyFileSync(srcBunLock, path.join(functionDockerPath, 'bun.lock'))
    }

    const handlerSrcDir = path.join(servicePath, handlerDir)
    const handlerDestDir = path.join(functionDockerPath, handlerDir)
    this.copyDir(handlerSrcDir, handlerDestDir)
  }

  generateRuntimeJs(functionDockerPath, handlerFile, handlerMethod) {
    const runtimeJs = `const api = process.env.AWS_LAMBDA_RUNTIME_API
const base = \`http://\${api}/2018-06-01/runtime\`

let handler

try {
  const handlerModule = await import('./${handlerFile}.ts')
  handler = handlerModule['${handlerMethod}'] || handlerModule.default

  if (!handler) {
    throw new Error('Handler function not found: ${handlerMethod}')
  }
} catch (error) {
  console.error('Init error:', error)
  await fetch(\`\${base}/init/error\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      errorType: 'InitError',
      errorMessage: error.message,
      stackTrace: error.stack?.split('\\n') || [],
    }),
  })
  process.exit(1)
}

while (true) {
  let requestId

  try {
    const res = await fetch(\`\${base}/invocation/next\`)
    requestId = res.headers.get('lambda-runtime-aws-request-id')
    const deadlineMs = res.headers.get('lambda-runtime-deadline-ms')
    const event = await res.json()

    const context = {
      awsRequestId: requestId,
      functionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
      functionVersion: process.env.AWS_LAMBDA_FUNCTION_VERSION,
      memoryLimitInMB: process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE,
      getRemainingTimeInMillis: () => Number(deadlineMs) - Date.now(),
    }

    const result = await handler(event, context)

    await fetch(\`\${base}/invocation/\${requestId}/response\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    })
  } catch (error) {
    console.error('Handler error:', error)
    if (requestId) {
      await fetch(\`\${base}/invocation/\${requestId}/error\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          errorType: error.constructor.name,
          errorMessage: error.message,
          stackTrace: error.stack?.split('\\n') || [],
        }),
      })
    }
  }
}
`
    fs.writeFileSync(path.join(functionDockerPath, 'runtime.js'), runtimeJs)
  }

  copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true })

    const entries = fs.readdirSync(src, { withFileTypes: true })

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name)
      const destPath = path.join(dest, entry.name)

      if (entry.isDirectory()) {
        this.copyDir(srcPath, destPath)
      } else {
        fs.copyFileSync(srcPath, destPath)
      }
    }
  }

  cleanup() {
    if (fs.existsSync(this.dockerPath)) {
      fs.rmSync(this.dockerPath, { recursive: true, force: true })
    }
  }
}
