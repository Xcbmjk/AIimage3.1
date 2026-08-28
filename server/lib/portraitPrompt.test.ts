import { describe, expect, it } from 'vitest'
import { scenePresets } from '../../src/mocks/fixtures/scenes'
import { stylePresets } from '../../src/mocks/fixtures/styles'
import { composePortraitPrompt } from './portraitPrompt'

describe('composePortraitPrompt', () => {
  it('combines the selected landmark with realistic identity and pose constraints', () => {
    const prompt = composePortraitPrompt(scenePresets.find((scene) => scene.id === 'great-wall')!, stylePresets.find((style) => style.mode === 'realistic')!)
    expect(prompt).toContain('八达岭长城')
    expect(prompt).toContain('严格保留人物可辨识身份')
    expect(prompt).toContain('保持输入人物的原始姿势')
    expect(prompt).toContain('禁止贴纸感')
  })

  it('allows only small pose changes in artistic mode', () => {
    const prompt = composePortraitPrompt(scenePresets.find((scene) => scene.id === 'west-lake')!, stylePresets.find((style) => style.mode === 'artistic')!)
    expect(prompt).toContain('杭州西湖')
    expect(prompt).toContain('允许根据画面小幅调整姿势和服装')
    expect(prompt).not.toContain('保持输入人物的原始姿势')
  })

  it('preserves the uploaded environment when no destination is selected', () => {
    const prompt = composePortraitPrompt(scenePresets.find((scene) => scene.id === 'portrait-only')!, stylePresets[0])
    expect(prompt).toContain('完整保留原始背景')
    expect(prompt).toContain('禁止替换背景')
    expect(prompt).not.toContain('指定目的地')
  })
})
