import { once } from 'node:events'
import { type AddressInfo, createServer, type Socket } from 'node:net'

const i16 = (n: number) => {
  const b = Buffer.alloc(2)
  b.writeInt16BE(n)
  return b
}
const i32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeInt32BE(n)
  return b
}
const cstr = (s: string) => Buffer.from(`${s}\0`)
const msg = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts)
  return Buffer.concat([Buffer.from(type, 'latin1'), i32(body.length + 4), body])
}
const READY = msg('Z', Buffer.from('I'))

/**
 * A stand-in for the Supabase pooler in transaction mode (port 6543), for the one behaviour
 * that matters here: it answers a transaction, hands the backend back at its ReadyForQuery, and
 * loses whatever the client pipelined behind that transaction's Sync, which is never answered
 * (the real pooler does the same: the first query of a pipelined burst returns, the others hang).
 * Every query gets no rows. `pipelined` counts the messages it lost. Transactions are not
 * supported by the stand-in: each Sync ends the "transaction" and returns the backend, so a
 * `BEGIN ... COMMIT` spanning several round trips is not modelled.
 */
export async function transactionPooler() {
  let pipelined = 0
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let buf = Buffer.alloc(0)
    let started = false
    // Between a Sync and its ReadyForQuery: what arrives now was pipelined.
    let busy = false
    let out: Buffer[] = []
    let params = 0
    const endTransaction = () => {
      busy = true
      const reply = Buffer.concat([...out, READY])
      out = []
      setTimeout(() => {
        busy = false
        if (!socket.destroyed) socket.write(reply)
      }, 20)
    }
    const handle = (type: string, body: Buffer) => {
      switch (type) {
        case 'P': {
          const text = body.subarray(body.indexOf(0) + 1, body.indexOf(0, body.indexOf(0) + 1))
          const refs = [...text.toString().matchAll(/\$(\d+)/g)].map((m) => Number(m[1]))
          params = Math.max(0, ...refs)
          out.push(msg('1'))
          return
        }
        case 'D':
          if (body[0] === 'S'.charCodeAt(0)) {
            out.push(msg('t', i16(params), ...Array.from({ length: params }, () => i32(25))))
          }
          out.push(msg('n'))
          return
        case 'B':
          out.push(msg('2'))
          return
        case 'E':
          out.push(msg('C', cstr('SELECT 0')))
          return
        case 'C':
          out.push(msg('3'))
          return
        case 'H':
          socket.write(Buffer.concat(out))
          out = []
          return
        case 'Q':
          out.push(msg('C', cstr('SELECT 0')))
          return endTransaction()
        case 'S':
          return endTransaction()
        case 'X':
          socket.end()
          return
      }
    }
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        if (!started) {
          if (buf.length < 8 || buf.length < buf.readInt32BE(0)) return
          const code = buf.readInt32BE(4)
          buf = buf.subarray(buf.readInt32BE(0))
          // SSL or GSS encryption request: refused, the client goes on in clear.
          if (code === 80877103 || code === 80877104) {
            socket.write('N')
            continue
          }
          started = true
          socket.write(
            Buffer.concat([
              msg('R', i32(0)),
              ...[
                ['server_version', '17.0'],
                ['client_encoding', 'UTF8'],
                ['DateStyle', 'ISO, MDY'],
                ['integer_datetimes', 'on'],
                ['standard_conforming_strings', 'on'],
              ].map(([k, v]) => msg('S', cstr(k as string), cstr(v as string))),
              msg('K', i32(4242), i32(1)),
              READY,
            ]),
          )
          continue
        }
        if (buf.length < 5 || buf.length < 1 + buf.readInt32BE(1)) return
        const type = String.fromCharCode(buf[0] as number)
        const end = 1 + buf.readInt32BE(1)
        const body = buf.subarray(5, end)
        buf = buf.subarray(end)
        if (busy) pipelined++
        else handle(type, body)
      }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  return {
    url: `postgres://keeper:pw@127.0.0.1:${port}/horagon`,
    get pipelined() {
      return pipelined
    },
    close() {
      for (const s of sockets) s.destroy()
      server.close()
    },
  }
}
