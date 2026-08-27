import type { ScenePreset, StylePreset } from '../../src/types'

export function composePortraitPrompt(scene: ScenePreset, style: StylePreset) {
  const identity = '以输入照片中的人物为唯一主角。严格保留人物可辨识身份，包括五官、脸型、肤色、年龄感和发型；不要生成第二个主要人物，不要改变种族或年龄。'
  const realistic = '这是写实旅拍模式。保持输入人物的原始姿势、身体朝向、肢体结构和人物比例；允许将服装自然调整为适合目的地的旅行穿着，但不得遮挡或重塑面部。'
  const artistic = '这是艺术融合模式。严格保持人物面部身份，允许根据画面小幅调整姿势和服装；不得大幅改变体型，不得让艺术效果掩盖五官。'
  const composition = '竖幅旅拍构图，人物占画面约百分之四十五，景点保持清晰可辨。匹配人物与环境的透视、焦距、景深、光源方向、面部受光、接触阴影、色温、空气透视和前后景遮挡，使人物真实处于场景中，禁止贴纸感、白边和悬浮感。'
  const quality = '高质量完整画面，脸部清晰，眼睛自然，双手和肢体结构正确，无重复人物、无多余肢体、无文字、无标志、无水印。'

  return [
    identity,
    style.mode === 'realistic' ? realistic : artistic,
    `指定目的地：${scene.location}。${scene.prompt}`,
    `表现风格：${style.name}。${style.prompt}`,
    composition,
    quality,
  ].join('\n')
}

export function withPortraitPrompt(scene: ScenePreset, style: StylePreset): StylePreset {
  return { ...style, prompt: composePortraitPrompt(scene, style) }
}
