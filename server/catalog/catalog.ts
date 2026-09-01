import { stylePresets } from '../../src/mocks/fixtures/styles'
import type { StylePreset } from '../../src/types'
import type { ServerConfig } from '../config'
import type { Database } from '../db/mysql'

export type PublishedPricing = { amountFen: number; description: string }

type StyleRow = {
  styleId: string
  name: string
  subtitle: string
  description: string
  prompt: string
  mode: 'realistic' | 'artistic'
  sortOrder: number
  previewData?: string | null
  paletteJson?: string | null
  motif?: string | null
}

const fallbackPalette: [string, string, string] = ['#35574a', '#c8a96b', '#edf1e8']

function placeholderImage(label: string) {
  const safeLabel = label.replace(/[<&>]/g, '')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200"><rect width="900" height="1200" fill="#35574a"/><circle cx="700" cy="240" r="150" fill="#c8a96b" opacity=".8"/><path d="M0 900 Q220 620 430 850 T900 780 V1200 H0Z" fill="#172f2a"/><text x="70" y="1050" fill="#edf1e8" font-size="54" font-family="serif">${safeLabel}</text></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function toStyle(row: StyleRow): StylePreset {
  const fixture = stylePresets.find((style) => style.id === row.styleId)
  let palette = fixture?.palette ?? fallbackPalette
  if (row.paletteJson) {
    try {
      const parsed = JSON.parse(row.paletteJson) as unknown
      if (Array.isArray(parsed) && parsed.length === 3 && parsed.every((value) => typeof value === 'string')) palette = parsed as [string, string, string]
    } catch {
      // Keep the safe fallback palette when legacy data is malformed.
    }
  }
  return {
    id: row.styleId,
    name: row.name,
    subtitle: row.subtitle,
    description: row.description,
    prompt: row.prompt,
    mode: row.mode,
    palette,
    motif: row.motif || fixture?.motif || row.name.slice(0, 1),
    resultImage: row.previewData?.startsWith('data:') ? row.previewData : row.previewData ? `/api/catalog/style-assets/${row.previewData.split('/').pop()!.split('.')[0]}` : fixture?.resultImage || placeholderImage(row.name),
  }
}

export async function getPublishedStyles(database?: Database | null) {
  if (!database) return stylePresets
  const rows = await database.query<Array<StyleRow>>(`SELECT style_id AS styleId, name, subtitle, description, prompt, mode, sort_order AS sortOrder, preview_data AS previewData, palette_json AS paletteJson, motif FROM style_versions WHERE status = 'published' AND enabled = 1 ORDER BY sort_order, style_id`)
  return rows.map(toStyle)
}

export async function getPublishedPricing(config: ServerConfig, database?: Database | null): Promise<PublishedPricing> {
  if (!database) return { amountFen: config.payment.amountFen, description: config.payment.description }
  const rows = await database.query<Array<PublishedPricing>>(`SELECT amount_fen AS amountFen, description FROM pricing_versions WHERE status = 'published' ORDER BY published_at DESC, id DESC LIMIT 1`)
  return rows[0] ?? { amountFen: config.payment.amountFen, description: config.payment.description }
}
