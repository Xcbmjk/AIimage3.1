import { test, expect, type Page } from '@playwright/test'

/**
 * End-to-end test for the mountain portrait kiosk flow.
 *
 * Covers: welcome → camera (demo photo) → review → style selection →
 * generation → results → QR/share → reset.
 *
 * The webServer config in playwright.config.ts starts:
 *   - Node API server with AI_PROVIDER=mock (overriding .env.local)
 *   - Vite dev server with /api proxy to 127.0.0.1:8787
 */

test.describe('山水 AI 旅拍 kiosk flow', () => {
  test.describe.configure({ timeout: 60_000 })
  const bodyPhoto = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="50"><rect width="40" height="50" fill="#35574a"/></svg>')
  // Collect browser console messages for debugging
  let consoleMessages: string[]

  test.beforeEach(async ({ page }) => {
    let paid = false
    await page.route('**/api/payments/orders', async (route) => {
      await route.fulfill({ json: { orderId: 'SJ202608110001MOCK', amountFen: 990, expiresAt: new Date(Date.now() + 300_000).toISOString(), codeUrl: 'weixin://wxpay/mock', mock: true } })
    })
    await page.route('**/api/payments/mock/*', async (route) => {
      paid = true
      await route.fulfill({ contentType: 'text/html', body: '<h1>模拟支付成功</h1>' })
    })
    await page.route('**/api/payments/orders/*?sessionId=*', async (route) => {
      await route.fulfill({ json: paid ? { status: 'paid', accessToken: 'e2e-paid-token' } : { status: 'pending' } })
    })
    await page.route('**/api/generation', async (route) => {
      const body = route.request().postDataJSON() as { photo: string; sceneId: string; styles: Array<{ id: string }> }
      expect(body.sceneId).toBe('portrait-only')
      await new Promise((resolve) => setTimeout(resolve, 200))
      await route.fulfill({ json: { provider: 'mock', assets: body.styles.map((style, index) => ({ id: `e2e-${index}`, styleId: style.id, imageUrl: body.photo })) } })
    })
    await page.route('**/api/shares', async (route) => {
      await route.fulfill({ status: 201, json: { url: 'http://192.168.1.20:8787/api/shares/e2e-share', expiresAt: new Date(Date.now() + 86_400_000).toISOString() } })
    })
    await page.route('**/api/catalog', async (route) => {
      await route.fulfill({ json: {
        styles: ['ink', 'gold', 'spring', 'night', 'van-gogh'].map((id) => ({ id, name: id, subtitle: 'sub', description: 'desc', palette: ['#111', '#222', '#333'], motif: 'M', resultImage: bodyPhoto, mode: 'artistic' })),
        backgrounds: [{ id: 'gate-steps', name: '门前石阶', subtitle: '坐姿', description: '坐姿背景', poseHint: '端坐', previewImage: bodyPhoto }, { id: 'ridge-walk', name: '山脊漫步', subtitle: '行走', description: '行走背景', poseHint: '行走', previewImage: bodyPhoto }],
        pricing: { amountFen: 990, description: 'x' },
        product: { maxStyles: 4, shareExpiryHours: 24 },
        runtime: { generationMode: 'api', paymentMode: 'mock', agentEnabled: true },
      } })
    })
    await page.route('**/api/agent/generation', async (route) => {
      const body = route.request().postDataJSON() as { photo: string; backgroundId: string }
      expect(body.backgroundId).toBeTruthy()
      await new Promise((resolve) => setTimeout(resolve, 200))
      await route.fulfill({ json: { provider: 'mock', prompt: '这是 Agent 动态生成的融合提示词，用于调试展示。', assets: [{ id: 'e2e-agent-0', styleId: body.backgroundId, imageUrl: body.photo }] } })
    })
    consoleMessages = []
    page.on('console', (msg) => {
      consoleMessages.push(`[${msg.type()}] ${msg.text()}`)
    })
    page.on('pageerror', (err) => {
      consoleMessages.push(`[pageerror] ${err.message}`)
    })

    await page.goto('/')
    await page.evaluate(() => localStorage.clear())
    await page.reload()
  })

  async function completeMockPayment(page: Page) {
    await expect(page.locator('.payment-screen')).toBeVisible()
    await expect(page.locator('.payment-qr svg')).toBeVisible()
    await page.locator('.mock-payment-button').click()
    await expect(page.locator('.camera-screen')).toBeVisible()
  }

  async function navigateToReview(page: Page) {
    await page.locator('.primary-cta--light').click()
    await completeMockPayment(page)
    await page.locator('.shutter', { hasText: '使用示例照片' }).click()
    await expect(page.locator('.paper-screen')).toBeVisible()
    await page.locator('.primary-cta', { hasText: '使用这张' }).click()
    await expect(page.locator('.mode-screen')).toBeVisible()
  }

  // Helper: navigate through welcome → payment → camera → review → mode → classic styles
  async function navigateToStyles(page: Page) {
    await navigateToReview(page)
    await page.locator('.mode-card').first().click()
    await expect(page.locator('.styles-screen')).toBeVisible()
  }

  test('complete visitor journey: welcome → camera → review → styles → generation → results → QR → reset', async ({ page }) => {

    // ── Step 1: Welcome page ──────────────────────────────────────────────
    test.info().annotations.push({ type: 'step', description: 'Welcome' })
    await expect(page).toHaveTitle(/山境造像/)
    await expect(page.locator('.welcome-screen')).toBeVisible()
    await expect(page.locator('.primary-cta--light')).toBeVisible()

    // The welcome action button starts the kiosk
    await page.locator('.primary-cta--light').click()

    // ── Step 2: WeChat payment gate ───────────────────────────────────────
    test.info().annotations.push({ type: 'step', description: 'Mock WeChat payment' })
    await completeMockPayment(page)

    // ── Step 3: Camera page (demo photo) ──────────────────────────────────
    test.info().annotations.push({ type: 'step', description: 'Camera (demo photo)' })
    await expect(page.locator('.camera-screen')).toBeVisible()
    await expect(page.locator('.step-pill')).toHaveText('02 / 05')

    // Click the demo photo button (fallback path, no camera permission needed)
    await page.locator('.shutter', { hasText: '使用示例照片' }).click()

    // ── Step 3: Review page ───────────────────────────────────────────────
    test.info().annotations.push({ type: 'step', description: 'Review' })
    await expect(page.locator('.paper-screen')).toBeVisible()
    await expect(page.locator('.portrait-frame img')).toBeVisible()
    await expect(page.locator('.primary-cta', { hasText: '使用这张' })).toBeVisible()
    await page.locator('.primary-cta', { hasText: '使用这张' }).click()

    // ── Step 3: Mode selection ────────────────────────────────────────────
    test.info().annotations.push({ type: 'step', description: 'Mode selection' })
    await expect(page.locator('.mode-screen')).toBeVisible()
    await page.locator('.mode-card', { hasText: '经典风格' }).click()

    // ── Step 3: Style selection ───────────────────────────────────────────
    test.info().annotations.push({ type: 'step', description: 'Style selection' })
    await expect(page.locator('.styles-screen')).toBeVisible()
    await expect(page.locator('.step-header h2')).toHaveText('选择人物风格')
    // Select first style
    const styleCards = page.locator('.style-card')
    await expect(styleCards).toHaveCount(5)
    await styleCards.nth(0).click()
    await expect(styleCards.nth(0)).toHaveClass(/style-card--selected/)

    // Select second style
    await styleCards.nth(1).click()
    await expect(styleCards.nth(1)).toHaveClass(/style-card--selected/)

    // Verify the sticky action counter
    await expect(page.locator('.sticky-action b')).toHaveText('2')

    // Start generation
    await page.locator('.primary-cta--compact').click()

    // ── Step 5: Generation page ───────────────────────────────────────────
    test.info().annotations.push({ type: 'step', description: 'Generation' })
    await expect(page.locator('.generating-screen')).toBeVisible()
    await expect(page.locator('.generating-brand')).toContainText('04 / 05')

    // Wait for generation to complete — the page transitions to results
    // when assets are ready. With mock provider this is fast (~360ms * 10 steps).
    await page.waitForSelector('.results-screen', { timeout: 30000 })
    await expect(page.locator('.results-screen')).toBeVisible()

    // ── Step 6: Results page ──────────────────────────────────────────────
    test.info().annotations.push({ type: 'step', description: 'Results' })
    await expect(page.locator('.step-header h2')).toHaveText('你的山水作品')

    // Two result thumbnails (one per selected style)
    await expect(page.locator('.result-thumbs button')).toHaveCount(2)

    // Verify the main result image is visible
    await expect(page.locator('.result-stage img')).toBeVisible()

    // ── Step 7: Share / QR ────────────────────────────────────────────────
    test.info().annotations.push({ type: 'step', description: 'Share / QR' })
    // Click the QR/share button
    await page.locator('.primary-cta', { hasText: '微信扫码保存' }).click()

    // Should transition to the download screen with a QR code
    await expect(page.locator('.download-screen')).toBeVisible()
    await expect(page.locator('.qr-frame')).toBeVisible()
    await expect(page.locator('.qr-frame svg')).toBeVisible() // QR code SVG rendered inside qr-frame

    // The mobile share link should be present
    const shareLink = page.locator('.debug-link')
    await expect(shareLink).toBeVisible()
    const linkHref = await shareLink.getAttribute('href')
    expect(linkHref).toBe('http://192.168.1.20:8787/api/shares/e2e-share')

    // ── Step 8: Reset and start over ────────────────────────────────────────
    test.info().annotations.push({ type: 'step', description: 'Reset + restart' })
    // Click "再拍一次" to test reset from download page
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleMessages.push(`[console-error] ${msg.text()}`)
    })

    await page.locator('.finish-button').click()

    // After reset, should be back at welcome
    await expect(page.locator('.welcome-screen')).toBeVisible()
    await page.locator('.primary-cta--light').click()

    // A new journey must require a new payment.
    await expect(page.locator('.payment-screen')).toBeVisible()

    // Log any console messages that might help debugging
    if (consoleMessages.length > 0) {
      test.info().attach('Console messages', { body: consoleMessages.join('\n') })
    }
  })

  test('allows selecting only one style', async ({ page }) => {
    await navigateToStyles(page)

    // Select only one style.
    const styleCards = page.locator('.style-card')
    await styleCards.nth(0).click()
    await expect(styleCards.nth(0)).toHaveClass(/style-card--selected/)

    // Generate and wait for results
    await page.locator('.primary-cta--compact').click()

    // Check that we reach the generating screen
    await expect(page.locator('.generating-screen')).toBeVisible()

    // Wait for generation to complete
    await page.waitForSelector('.results-screen', { timeout: 30000 })
    await expect(page.locator('.results-screen')).toBeVisible()
    await expect(page.locator('.result-thumbs button')).toHaveCount(1)

    // Log console messages for debugging
    if (consoleMessages.length > 0) {
      test.info().attach('Console messages', { body: consoleMessages.join('\n') })
    }
  })

  test('prevents selecting more styles than the maximum', async ({ page }) => {
    await navigateToStyles(page)

    // Select four styles (the configured maximum)
    const styleCards = page.locator('.style-card')
    await styleCards.nth(0).click()
    await styleCards.nth(1).click()
    await styleCards.nth(2).click()
    await styleCards.nth(3).click()

    // Try to select a fifth — should not be added
    await styleCards.nth(4).click({ force: true })
    await expect(styleCards.nth(4)).not.toHaveClass(/style-card--selected/)

    // Verify only 4 are selected in the counter
    await expect(page.locator('.sticky-action b')).toHaveText('4')
    await expect(page.locator('.sticky-action small')).toHaveText(/已达到本次体验上限/)

    // Verify the generate button is still enabled at the maximum.
    await expect(page.locator('.primary-cta--compact')).toBeEnabled()
  })

  test('can go back through the mode screen to review', async ({ page }) => {
    await navigateToStyles(page)

    // Back from styles to the mode screen
    await page.locator('.icon-button').click()
    await expect(page.locator('.mode-screen')).toBeVisible()

    // Back from mode to review
    await page.locator('.icon-button').click()
    await expect(page.locator('.step-header h2')).toHaveText('确认照片')

    // Forward again through mode into styles
    await page.locator('.primary-cta', { hasText: '使用这张' }).click()
    await expect(page.locator('.mode-screen')).toBeVisible()
    await page.locator('.mode-card').first().click()
    await expect(page.locator('.styles-screen')).toBeVisible()
  })

  test('agent mode selects a background, analyzes and returns a single prompt-bearing result', async ({ page }) => {
    await navigateToReview(page)
    await page.locator('.mode-card--agent').click()
    await expect(page.locator('.backgrounds-screen')).toBeVisible()
    await expect(page.locator('.background-card')).toHaveCount(2)

    await page.locator('.background-card').first().click()
    await expect(page.locator('.background-card--selected')).toHaveCount(1)
    await expect(page.locator('.primary-cta--compact')).toBeEnabled()
    await page.locator('.primary-cta--compact').click()

    await expect(page.locator('.generating-screen')).toBeVisible()
    await page.waitForSelector('.results-screen', { timeout: 30_000 })
    await expect(page.locator('.results-screen')).toBeVisible()
    await expect(page.locator('.result-thumbs button')).toHaveCount(1)

    // The dynamic prompt debug disclosure is present and expands
    await expect(page.locator('.agent-prompt')).toBeVisible()
    await page.locator('.agent-prompt summary').click()
    await expect(page.locator('.agent-prompt pre')).toContainText('Agent 动态生成')
  })
})
