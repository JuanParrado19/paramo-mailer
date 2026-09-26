import { MailerError } from './errors.js'
import type { Address, AddressInput } from './types.js'

// Deliberadamente simple: la validación real la hace el servidor de correo.
// Aquí solo se descarta lo que es claramente inválido.
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/
const NAMED_RE = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/
// CR/LF en una cabecera permitiría inyectar cabeceras nuevas (Bcc: …).
const HEADER_UNSAFE = /[\r\n]/

export const isValidEmail = (value: string): boolean =>
  value.length <= 254 && EMAIL_RE.test(value)

export function parseAddress(input: AddressInput): Address {
  let name: string | undefined
  let address: string

  if (typeof input === 'string') {
    const named = NAMED_RE.exec(input)
    if (named) {
      name = named[1]?.trim() || undefined
      address = named[2]!.trim()
    } else {
      address = input.trim()
    }
  } else if (input && typeof input === 'object' && typeof input.address === 'string') {
    name = input.name?.trim() || undefined
    address = input.address.trim()
  } else {
    throw new MailerError('INVALID_ADDRESS', 'Dirección vacía o con formato desconocido')
  }

  if ((name && HEADER_UNSAFE.test(name)) || HEADER_UNSAFE.test(address)) {
    throw new MailerError('INVALID_ADDRESS', 'La dirección contiene saltos de línea')
  }
  if (!isValidEmail(address)) {
    throw new MailerError('INVALID_ADDRESS', `Dirección inválida: ${address}`)
  }
  return name ? { name, address } : { address }
}

export const parseAddressList = (input: AddressInput | AddressInput[] | undefined): Address[] =>
  input === undefined ? [] : (Array.isArray(input) ? input : [input]).map(parseAddress)

export const formatAddress = (a: Address): string =>
  a.name ? `"${a.name.replace(/["\\]/g, '\\$&')}" <${a.address}>` : a.address

export const assertHeaderSafe = (label: string, value: string): void => {
  if (HEADER_UNSAFE.test(value)) {
    throw new MailerError('INVALID_MESSAGE', `${label} no puede contener saltos de línea`)
  }
}
