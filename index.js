import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync } from 'child_process'

export default class ServerlessBunPlugin {
  constructor(serverless, options) {
    this.serverless = serverless
    this.options = options
    this.log = serverless.cli || console

    let customBun = this.serverless.service.custom?.bun || {}
    this.bunVersion = customBun.version || 'latest'
    this.minify = customBun.minify !== false

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
    const handlerMethod = handlerParts[handlerParts.length - 1]

    const eventData = this.options.data || '{}'
    const eventPath = this.options.path

    let event = eventData

    if (eventPath) {
      event = fs.readFileSync(eventPath, 'utf-8')
    }

    const servicePath = this.serverless.config.servicePath
    const handlerFullPath = path.join(servicePath, `${handlerFile}.ts`)

    const invokeScript = `
import * as handlerModule from '${handlerFullPath}';

const handler = handlerModule['${handlerMethod}'] || handlerModule.default;
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

      this.log.log(`bun: building ${name}`)

      const arch = fn.architecture || service.provider.architecture || 'x86_64'

      await this.buildAndPackage(name, fn, arch)

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

    this.log.log(`bun: building ${functionName}`)

    const arch = fn.architecture || service.provider.architecture || 'x86_64'

    await this.buildAndPackage(functionName, fn, arch)

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

  async buildAndPackage(name, fn, arch) {
    const servicePath = this.serverless.config.servicePath
    const functionDockerPath = path.join(this.dockerPath, name)

    fs.mkdirSync(functionDockerPath, { recursive: true })

    const handlerParts = fn.handler.split('.')
    const handlerFile = handlerParts.slice(0, -1).join('.')
    const handlerMethod = handlerParts[handlerParts.length - 1]

    const entryPoint = path.join(servicePath, `${handlerFile}.ts`)

    this.generateBootstrapEntry(functionDockerPath, entryPoint, handlerMethod)

    this.compileBootstrap(servicePath, functionDockerPath, arch)

    this.generateDockerfile(functionDockerPath)
  }

  generateBootstrapEntry(functionDockerPath, entryPoint, handlerMethod) {
    const bootstrapEntry = `import * as handlerModule from '${entryPoint}'

const api = process.env.AWS_LAMBDA_RUNTIME_API
const base = \`http://\${api}/2018-06-01/runtime\`

const handler = handlerModule['${handlerMethod}'] || handlerModule.default

if (!handler) {
  console.error('Handler function not found: ${handlerMethod}')
  process.exit(1)
}

function isFunctionUrl(event) {
  const domain = event?.requestContext?.domainName || ''
  return domain.includes('.lambda-url.') && domain.endsWith('.on.aws')
}

function formatFunctionUrlResponse(result) {
  if (result && typeof result === 'object' && 'statusCode' in result) {
    const headers = result.headers || {}
    const body = result.body || ''
    const isBase64 = result.isBase64Encoded || false

    return new Response(isBase64 ? Buffer.from(body, 'base64') : body, {
      status: result.statusCode,
      headers: headers,
    })
  }
  return null
}

async function main() {
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

      if (isFunctionUrl(event)) {
        const response = formatFunctionUrlResponse(result)

        if (response) {
          const responseHeaders = { 'Content-Type': response.headers.get('content-type') || 'application/json' }

          for (const [key, value] of response.headers.entries()) {
            if (key.toLowerCase() !== 'content-type') {
              responseHeaders[\`Lambda-Runtime-Function-Response-\${key}\`] = value
            }
          }

          await fetch(\`\${base}/invocation/\${requestId}/response\`, {
            method: 'POST',
            headers: responseHeaders,
            body: response.body,
          })
          continue
        }
      }

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
}

main().catch((error) => {
  console.error('Init error:', error)
  process.exit(1)
})
`

    fs.writeFileSync(path.join(functionDockerPath, 'bootstrap.ts'), bootstrapEntry)
  }

  compileBootstrap(servicePath, functionDockerPath, arch) {
    const bootstrapFile = path.join(functionDockerPath, 'bootstrap.ts')
    const outFile = path.join(functionDockerPath, 'bootstrap')

    const target = arch === 'arm64' ? 'bun-linux-arm64' : 'bun-linux-x64'
    const minifyFlag = this.minify ? '--minify' : ''

    const cmd = [
      'bun',
      'build',
      '--compile',
      `--target=${target}`,
      bootstrapFile,
      '--outfile',
      outFile,
      minifyFlag,
      '--bytecode',
    ]
      .filter(Boolean)
      .join(' ')

    this.log.log(`bun: compiling for ${target}`)

    try {
      execSync(cmd, {
        cwd: servicePath,
        stdio: 'pipe',
      })
    } catch (error) {
      this.log.log(`bun: compilation failed`)
      throw new Error(`Compilation failed: ${error.stderr?.toString() || error.message}`)
    }

    const stats = fs.statSync(outFile)
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2)
    this.log.log(`bun: executable size: ${sizeMB}MB`)
  }

  generateDockerfile(functionDockerPath) {
    const dockerfile = `FROM public.ecr.aws/lambda/provided:al2023

WORKDIR /var/task

COPY bootstrap ./bootstrap

RUN chmod +x bootstrap

ENV HOME=/tmp
ENV TMPDIR=/tmp

ENTRYPOINT ["./bootstrap"]
`

    fs.writeFileSync(path.join(functionDockerPath, 'Dockerfile'), dockerfile)
  }

  cleanup() {
    if (fs.existsSync(this.dockerPath)) {
      fs.rmSync(this.dockerPath, { recursive: true, force: true })
    }
  }
}
