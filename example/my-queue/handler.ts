export default async function main(event: any, context: any) {
  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Hello, world!' }),
  }
}
