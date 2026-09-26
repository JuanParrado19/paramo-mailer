import { MailerError } from './errors.js'
import type { Template, TemplateOutput } from './types.js'

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!)

const lookup = (data: Record<string, unknown>, path: string): unknown =>
  path.split('.').reduce<unknown>(
    (acc, key) => (acc !== null && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined),
    data,
  )

const stringify = (value: unknown): string =>
  value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)

/**
 * Interpolación mínima estilo Mustache:
 *   {{ user.name }}   escapado para HTML cuando `escape` es true
 *   {{{ html }}}      sin escapar, para fragmentos de confianza
 * Una variable ausente se reemplaza por cadena vacía.
 */
export function interpolate(source: string, data: Record<string, unknown>, escape: boolean): string {
  return source
    .replace(/\{\{\{\s*([\w.]+)\s*\}\}\}/g, (_, path: string) => stringify(lookup(data, path)))
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
      const value = stringify(lookup(data, path))
      return escape ? escapeHtml(value) : value
    })
}

export async function renderTemplate(
  template: Template,
  data: Record<string, unknown>,
): Promise<TemplateOutput> {
  if (typeof template === 'function') return template(data)
  return {
    // El asunto va a una cabecera: sin escapar HTML, y sin saltos de línea
    // aunque vengan en los datos.
    subject:
      template.subject === undefined
        ? undefined
        : interpolate(template.subject, data, false).replace(/[\r\n]+/g, ' '),
    html: template.html === undefined ? undefined : interpolate(template.html, data, true),
    text: template.text === undefined ? undefined : interpolate(template.text, data, false),
  }
}

export class TemplateRegistry {
  private readonly templates = new Map<string, Template>()

  constructor(initial: Record<string, Template> = {}) {
    for (const [name, template] of Object.entries(initial)) this.register(name, template)
  }

  register(name: string, template: Template): this {
    this.templates.set(name, template)
    return this
  }

  has(name: string): boolean {
    return this.templates.has(name)
  }

  async render(name: string, data: Record<string, unknown>): Promise<TemplateOutput> {
    const template = this.templates.get(name)
    if (!template) throw new MailerError('TEMPLATE_NOT_FOUND', `No existe la plantilla "${name}"`)
    return renderTemplate(template, data)
  }
}
