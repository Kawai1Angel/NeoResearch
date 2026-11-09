export * from "./client.js"
export * from "./server.js"

import { createNeoResearchClient } from "./client.js"
import { createNeoResearchServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export * as data from "./data.js"

export async function createNeoResearch(options?: ServerOptions) {
  const server = await createNeoResearchServer({
    ...options,
  })

  const client = createNeoResearchClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
