import { isValidEmail } from '../address.js'
import { escapeHtml, interpolate, renderTemplate } from '../template.js'
import type { MessageInput, TemplateOutput } from '../types.js'
import type { FieldConfig, FormConfig } from './config.js'
import { HttpError } from './http.js'

const URL_RE = /^https?:\/\/\S+$/i

/** Etiqueta para errores y para el correo: la configurada o la clave capitalizada. */
const labelOf = (key: string, field: FieldConfig) => field.label ?? key.charAt(0).toUpperCase() + key.slice(1)

/** Valida los campos declarados; ignora cualquier otro que llegue. */
export function validateFields(form: FormConfig, data: Record<string, unknown>): Record<string, string> {
  const values: Record<string, string> = {}
  const errors: Record<string, string> = {}

  for (const [key, field] of Object.entries(form.fields)) {
    const raw = data[key]
    const value = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : ''
    const max = field.maxLength ?? (field.type === 'textarea' ? 5000 : 200)
    const label = labelOf(key, field)

    if (!value) {
      if (field.required) errors[key] = `${label} is required.`
      continue
    }
    if (value.length > max) errors[key] = `${label} is too long (max ${max} characters).`
    else if (field.type === 'email' && !isValidEmail(value)) errors[key] = `${label} must be a valid email address.`
    else if (field.type === 'url' && !URL_RE.test(value)) errors[key] = `${label} must be a valid URL.`
    else if (field.type === 'number' && !Number.isFinite(Number(value))) errors[key] = `${label} must be a number.`
    else if (field.type === 'select' && field.options && !field.options.includes(value)) {
      errors[key] = `${label} has an invalid value.`
    }
    // Todo lo que no sea textarea es una línea: fuera saltos (van a asunto o cabeceras).
    values[key] = field.type === 'textarea' ? value : value.replace(/[\r\n]+/g, ' ')
  }

  if (Object.keys(errors).length) {
    throw new HttpError(400, Object.values(errors)[0]!, { fields: errors })
  }
  return values
}


/** Correo por defecto: una tabla con cada campo. */
export function defaultFormBody(formId: string, form: FormConfig, values: Record<string, string>): TemplateOutput {
  const rows = Object.entries(form.fields).map(([key, field]) => [labelOf(key, field), values[key] || '—'] as const)
  const text = rows.map(([label, value]) => (value.includes('\n') ? `${label}:\n${value}` : `${label}: ${value}`)).join('\n\n')
  const html = `<table cellpadding="8" style="font-family:Arial,sans-serif;font-size:14px;border-collapse:collapse">${rows
    .map(
      ([label, value]) =>
        `<tr><td style="vertical-align:top;color:#555;white-space:nowrap"><b>${escapeHtml(label)}</b></td>` +
        `<td style="white-space:pre-wrap">${escapeHtml(value)}</td></tr>`,
    )
    .join('')}</table><p style="font-family:Arial,sans-serif;font-size:12px;color:#999">Form: ${escapeHtml(formId)}</p>`
  return { html, text }
}

export async function buildFormMessage(
  formId: string,
  form: FormConfig,
  values: Record<string, string>,
): Promise<MessageInput> {
  const replyToField =
    form.replyToField === false
      ? undefined
      : (form.replyToField ?? Object.entries(form.fields).find(([, f]) => f.type === 'email')?.[0])
  const replyTo = replyToField ? values[replyToField] : undefined

  let body: TemplateOutput
  let template: string | undefined
  if (typeof form.template === 'string') template = form.template
  else if (form.template) body = await renderTemplate(form.template, values)
  else body = defaultFormBody(formId, form, values)

  return {
    to: form.to,
    ...(form.from && { from: form.from }),
    ...(form.transport && { transport: form.transport }),
    ...(replyTo && { replyTo }),
    subject: interpolate(form.subject, values, false).replace(/[\r\n]+/g, ' '),
    ...(template ? { template, data: values } : { html: body!.html, text: body!.text }),
    tags: { form: formId },
  }
}

/** '*' permite cualquiera; sin lista, también (pero se avisa al arrancar). */
export function isOriginAllowed(origin: string | undefined, allowed: string[] | undefined): boolean {
  if (!allowed || allowed.includes('*')) return true
  if (!origin) return false
  return allowed.some((a) => a.replace(/\/$/, '').toLowerCase() === origin.toLowerCase())
}
