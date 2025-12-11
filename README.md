# Serverless Bun Plugin

This is a plugin for Serverless Framework that allows you to use Bun as a runtime for your Lambda functions.

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

## Configuration (optional)

```yaml
custom:
  bun:
    version: 1.3.4
```

## Example

See [example](./example) for more details.

Using `runtime: bun:1.x`

```yaml
functions:
  my-queue:
    handler: my-queue/handler.default
    runtime: bun:1.x
    memorySize: 256
    timeout: 30
```

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