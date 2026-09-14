import path from 'node:path'
import { expect, test } from '@playwright/test'

test('real upload and GPT Image generation', async ({ page }) => {
  test.setTimeout(360_000)
  let generationResponse: { status: number; body: string } | undefined

  page.on('response', async (response) => {
    if (response.url().endsWith('/api/generation')) {
      generationResponse = { status: response.status(), body: await response.text() }
    }
  })

  await page.goto('/')
  await page.locator('.primary-cta--light').click()
  await expect(page.locator('.payment-qr svg')).toBeVisible()
  await page.locator('.mock-payment-button').click()
  await expect(page.locator('.camera-screen')).toBeVisible()

  await page.locator('.photo-upload-input').setInputFiles(path.resolve('src/test/PixPin_2026-07-03_14-12-16.png'))
  await expect(page.locator('.portrait-frame img')).toBeVisible()
  await page.locator('.primary-cta', { hasText: '使用这张' }).click()
  await page.locator('.style-card').first().click()
  await page.locator('.primary-cta--compact').click()

  await Promise.race([
    page.locator('.results-screen').waitFor({ state: 'visible', timeout: 330_000 }),
    page.locator('.generation-error').waitFor({ state: 'visible', timeout: 330_000 }).then(async () => {
      throw new Error(`页面生成失败：${await page.locator('.generation-error').innerText()}`)
    }),
  ])

  console.log('generation response', generationResponse)
  expect(generationResponse?.status).toBe(200)
  await expect(page.locator('.result-thumbs button')).toHaveCount(1)
})
