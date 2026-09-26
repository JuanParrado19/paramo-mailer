import { describe, expect, it } from 'vitest'
import { MailerError, createMailer, interpolate, memory, parseAddress, renderTemplate, type Message } from '../src/index.js'

describe('plantillas', () => {
  it('escapa HTML en {{ }} y no en {{{ }}}', () => {
    const data = { name: '<b>Ana</b>', raw: '<i>ok</i>' }
    expect(interpolate('Hola {{ name }} {{{raw}}}', data, true)).toBe('Hola &lt;b&gt;Ana&lt;/b&gt; <i>ok</i>')
  })

  it('resuelve rutas con punto y deja vacío lo que falta', () => {
    expect(interpolate('{{user.name}}-{{missing}}-{{user.age}}', { user: { name: 'Ana', age: 30 } }, true)).toBe('Ana--30')
  })

  it('el asunto no escapa HTML ni admite saltos de línea', async () => {
    const out = await renderTemplate({ subject: 'Hola {{n}}', html: '<p>{{n}}</p>' }, { n: 'A & B\r\nBcc: x@y.z' })
    expect(out.subject).toBe('Hola A & B Bcc: x@y.z')
    expect(out.html).toBe('<p>A &amp; B\r\nBcc: x@y.z</p>')
  })

  it('acepta plantillas función (cualquier motor)', async () => {
    expect(await renderTemplate((d) => ({ subject: `S ${d.x}` }), { x: 1 })).toEqual({ subject: 'S 1' })
  })
})

describe('direcciones', () => {
  it('separa nombre y correo', () => {
    expect(parseAddress('Ana Pérez <ana@x.com>')).toEqual({ name: 'Ana Pérez', address: 'ana@x.com' })
    expect(parseAddress('"Ana" <ana@x.com>')).toEqual({ name: 'Ana', address: 'ana@x.com' })
    expect(parseAddress({ address: ' ana@x.com ' })).toEqual({ address: 'ana@x.com' })
  })

  it('rechaza direcciones inválidas y la inyección de cabeceras', () => {
    expect(() => parseAddress('no-es-correo')).toThrow(MailerError)
    expect(() => parseAddress('a@b.com\r\nBcc: c@d.com')).toThrow(/saltos de línea/)
    expect(() => parseAddress({ name: 'x\nBcc: y', address: 'a@b.com' })).toThrow(/saltos de línea/)
  })
})

describe('mailer', () => {
  it('aplica from por defecto, globals y plantilla; lo explícito gana', async () => {
    const t = memory()
    const mailer = createMailer({
      transport: t,
      from: 'Web <web@x.com>',
      globals: { brand: 'RVROX' },
      templates: { hi: { subject: 'Hola {{name}} de {{brand}}', html: '<p>{{name}}</p>', text: 'Hola {{name}}' } },
    })
    await mailer.send({ to: 'a@b.com', template: 'hi', data: { name: 'Ana' } })
    await mailer.send({ to: 'a@b.com', template: 'hi', data: { name: 'Ana' }, subject: 'Otro' })
    expect(t.sent[0]).toMatchObject({ from: { name: 'Web', address: 'web@x.com' }, subject: 'Hola Ana de RVROX', html: '<p>Ana</p>' })
    expect(t.sent[1]!.subject).toBe('Otro')
  })

  it('valida antes de enviar', async () => {
    const mailer = createMailer({ transport: memory(), from: 'a@b.com' })
    await expect(mailer.send({ to: [], subject: 's', text: 't' })).rejects.toMatchObject({ code: 'INVALID_MESSAGE' })
    await expect(mailer.send({ to: 'a@b.com', text: 't' })).rejects.toThrow(/asunto/)
    await expect(mailer.send({ to: 'a@b.com', subject: 's' })).rejects.toThrow(/cuerpo/)
    await expect(mailer.send({ to: 'a@b.com', subject: 's', text: 't', template: 'nope' })).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' })
    await expect(mailer.send({ to: 'a@b.com', subject: 's', text: 't', headers: { 'X-A': 'a\r\nBcc: z@z.com' } })).rejects.toThrow(/saltos/)
  })

  it('reintenta errores temporales y no los permanentes', async () => {
    const flaky = memory({
      beforeSend: (_m, attempt) => {
        if (attempt < 3) throw new MailerError('TRANSPORT_ERROR', 'temporal', { retryable: true })
      },
    })
    const mailer = createMailer({ transport: flaky, from: 'a@b.com', retry: { attempts: 3, minDelayMs: 1 } })
    await mailer.send({ to: 'c@d.com', subject: 's', text: 't' })
    expect(flaky.sent).toHaveLength(1)

    let calls = 0
    const broken = memory({
      beforeSend: () => {
        calls++
        throw new MailerError('TRANSPORT_ERROR', 'buzón no existe', { retryable: false })
      },
    })
    const mailer2 = createMailer({ transport: broken, from: 'a@b.com', retry: { attempts: 5, minDelayMs: 1 } })
    await expect(mailer2.send({ to: 'c@d.com', subject: 's', text: 't' })).rejects.toThrow('buzón no existe')
    expect(calls).toBe(1)
  })

  it('hace failover al siguiente transporte solo si el error es temporal', async () => {
    const down = memory({
      name: 'primary',
      beforeSend: () => {
        throw new MailerError('TRANSPORT_ERROR', 'caído', { retryable: true })
      },
    })
    const backup = memory({ name: 'backup' })
    const events: boolean[] = []
    const mailer = createMailer({
      transport: [down, backup],
      from: 'a@b.com',
      retry: { attempts: 2, minDelayMs: 1 },
      onSend: (e) => events.push(e.ok),
    })
    const result = await mailer.send({ to: 'c@d.com', subject: 's', text: 't' })
    expect(result.transport).toBe('backup')
    expect(events).toEqual([true])
  })

  it('elige transporte por mensaje o por defecto', async () => {
    const a = memory({ name: 'a' })
    const b = memory({ name: 'b' })
    const mailer = createMailer({ transport: [a, b], defaultTransport: 'b', from: 'x@y.com' })
    await mailer.send({ to: 'c@d.com', subject: 's', text: 't' })
    await mailer.send({ to: 'c@d.com', subject: 's', text: 't', transport: 'a' })
    expect([a.sent.length, b.sent.length]).toEqual([1, 1])
    await expect(mailer.send({ to: 'c@d.com', subject: 's', text: 't', transport: 'zzz' })).rejects.toMatchObject({ code: 'CONFIG_ERROR' })
  })

  it('sendMany respeta la concurrencia y nunca lanza', async () => {
    let active = 0
    let peak = 0
    const t = memory({
      beforeSend: async (m: Message) => {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 10))
        active--
        if (m.to[0]!.address === 'bad@x.com') throw new MailerError('TRANSPORT_ERROR', 'rechazado')
      },
    })
    const mailer = createMailer({ transport: t, from: 'a@b.com' })
    const inputs = Array.from({ length: 12 }, (_, i) => ({ to: i === 5 ? 'bad@x.com' : `u${i}@x.com`, subject: 's', text: 't' }))
    const results = await mailer.sendMany(inputs, { concurrency: 3 })
    expect(peak).toBe(3)
    expect(results.filter((r) => r.ok)).toHaveLength(11)
    expect(results[5]).toMatchObject({ ok: false })
  })
})
