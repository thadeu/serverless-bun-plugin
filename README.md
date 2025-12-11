# Serverless Bun Plugin

A Serverless Framework plugin that enables Bun runtime for AWS Lambda functions using Docker container images.

## Requirements

- Bun installed locally (for bundling)
- Docker installed and running
- Serverless Framework v3+
- AWS account with ECR access

## Installation

```bash
npm install serverless-bun-plugin
```

or using yarn

```bash
yarn add serverless-bun-plugin
```

or using pnpm

```bash
pnpm add serverless-bun-plugin
```

or using bun

```bash
bun add serverless-bun-plugin
```

## Usage

```yaml
plugins:
  - serverless-bun-plugin
```

## Configuration

```yaml
custom:
  bun:
    version: 1.3.4    # Bun version for compilation (default: latest)
    minify: true      # Minify compiled output (default: true)
```

### Architecture

The plugin supports both `x86_64` (default) and `arm64` architectures:

```yaml
provider:
  architecture: arm64

functions:
  my-function:
    handler: src/handler.default
    runtime: bun:1.x
    architecture: arm64
```

## Example

See [example](./example) for more details.

### Function-level runtime

```yaml
functions:
  my-queue:
    handler: my-queue/handler.default
    runtime: bun:1.x
    memorySize: 256
    timeout: 30
```

### Provider-level runtime

```yaml
provider:
  name: aws
  runtime: bun:1.x

functions:
  my-queue:
    handler: my-queue/handler.default
    memorySize: 256
    timeout: 30
```

## Local Invoke

The plugin supports local invocation using Bun:

```bash
serverless invoke local -f myFunction
```

With event data:

```bash
serverless invoke local -f myFunction -d '{"key": "value"}'
```

With event file:

```bash
serverless invoke local -f myFunction -p event.json
```

## How It Works

This plugin uses **Bun's compile feature** to create a standalone executable with everything bundled. This approach provides:

- **Standalone executable**: Single binary with runtime + code (no dependencies)
- **Full TypeScript support**: Including `tsconfig.json` paths and aliases
- **Minimal memory footprint**: ~10-30MB usage (vs 130MB+ with interpreted code)
- **Smaller container images**: ~100-150MB total (only base Lambda + executable)
- **Faster cold starts**: Pre-compiled code loads instantly
- **No Bun runtime needed**: Executable includes everything

### Deployment Flow

```mermaid
flowchart TD
    A[serverless deploy] --> B{Detect bun:1.x runtime}
    B --> C[Generate bootstrap.ts entry]
    C --> D[bun build --compile]
    D --> E[Create standalone executable]
    E --> F[Generate minimal Dockerfile]
    F --> G[Build Docker image]
    G --> H[Push to ECR]
    H --> I[Deploy Lambda with container image]
    I --> J[Cleanup temp files]
```

### Lambda Execution Flow

```mermaid
sequenceDiagram
    participant API as Lambda Runtime API
    participant EXE as bootstrap executable
    participant H as Handler (compiled)

    EXE->>H: Load handler (instant)
    H-->>EXE: Handler ready

    loop Event Loop
        EXE->>API: GET /invocation/next
        API-->>EXE: Event + Request ID
        EXE->>H: handler(event, context)
        H-->>EXE: Response
        EXE->>API: POST /invocation/{id}/response
    end
```

### Process Steps

1. The plugin intercepts functions with `bun:1.x` runtime
2. Generates a `bootstrap.ts` entry file that combines Lambda Runtime API logic + handler
3. Runs `bun build --compile` to create a standalone executable
4. Generates a minimal Dockerfile using only `public.ecr.aws/lambda/provided:al2023`
5. Configures ECR image deployment automatically
6. Cleans up temporary files after packaging

## License

MIT License

Copyright (c) 2025 Thadeu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.