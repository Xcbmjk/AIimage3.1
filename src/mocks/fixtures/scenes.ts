import type { ScenePreset } from '../../types'

const scenePreview = (label: string, sky: string, land: string, accent: string, shape: string) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="640" viewBox="0 0 900 640"><defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop stop-color="${sky}"/><stop offset="1" stop-color="${accent}"/></linearGradient><filter id="grain"><feTurbulence baseFrequency=".8" numOctaves="3"/><feColorMatrix values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 .1 0"/></filter></defs><rect width="900" height="640" fill="url(#sky)"/><path d="${shape}" fill="${land}"/><circle cx="710" cy="130" r="72" fill="#fff3cf" opacity=".72"/><rect width="900" height="640" filter="url(#grain)"/><text x="56" y="530" fill="#fff8e8" font-size="50" font-family="serif" letter-spacing="9">${label}</text><text x="60" y="574" fill="#fff" opacity=".72" font-size="18" font-family="sans-serif" letter-spacing="5">SCENIC PORTRAIT</text></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

export const scenePresets: ScenePreset[] = [
  {
    id: 'great-wall',
    name: '长城云脊',
    location: '八达岭长城',
    description: '烽火台沿山脊展开，苍青群山与古老城墙形成辽阔纵深。',
    prompt: '八达岭长城实景，保存完整且具有辨识度的古城墙、烽火台、垛口和层叠山脉，晴朗通透的北方自然光，空间纵深明确。',
    previewImage: scenePreview('长城云脊', '#7897a3', '#263f36', '#d9b77f', 'M0 430 Q130 315 245 385 T470 345 T680 330 T900 390 V640 H0Z M80 448 L820 294 L840 330 L100 484Z'),
  },
  {
    id: 'west-lake',
    name: '西湖烟水',
    location: '杭州西湖',
    description: '湖面、远山与柳岸相映，保留江南水色的温润和呼吸感。',
    prompt: '杭州西湖实景，平静湖面、苏堤柳岸、远山薄雾与江南亭影清晰可辨，柔和漫射日光，水面倒影自然。',
    previewImage: scenePreview('西湖烟水', '#87aaa9', '#1f514b', '#d7cfad', 'M0 365 Q180 275 330 350 T650 325 T900 350 V410 H0Z M0 410 H900 V640 H0Z'),
  },
  {
    id: 'jade-dragon',
    name: '雪山晴岚',
    location: '玉龙雪山',
    description: '雪峰、冷雾与高原天光，让人物置身清冽宏大的山境。',
    prompt: '玉龙雪山实景，锐利雪峰、冰川纹理、高原冷雾与山麓草甸层次分明，清冽高海拔日光，雪面高光不过曝。',
    previewImage: scenePreview('雪山晴岚', '#6f93ad', '#24443e', '#dce7e1', 'M0 430 L170 315 L280 375 L440 160 L610 370 L740 260 L900 425 V640 H0Z'),
  },
  {
    id: 'sanya-coast',
    name: '南海晴光',
    location: '三亚海边',
    description: '碧海、沙滩与热带天光，营造明亮松弛的海岸旅拍。',
    prompt: '三亚热带海岸实景，清澈碧海、细白沙滩、自然海浪和少量椰影，明亮温暖的海边日光，天空与海平线干净通透。',
    previewImage: scenePreview('南海晴光', '#56a9bd', '#16666c', '#efd49d', 'M0 360 Q180 330 360 365 T720 350 T900 360 V470 H0Z M0 470 Q230 430 470 485 T900 455 V640 H0Z'),
  },
  {
    id: 'portrait-only',
    name: '原景留存',
    location: '原始环境',
    description: '保留上传照片中的背景、构图与光线，只调整人物的表现风格。',
    prompt: '以输入照片为唯一场景来源，完整保留原始背景、地点特征、构图、机位、透视、人物落位和环境光线，不添加或替换景点。',
    previewImage: scenePreview('原景留存', '#7897a3', '#263f36', '#d9b77f', 'M0 430 Q130 315 245 385 T470 345 T680 330 T900 390 V640 H0Z'),
  },
]
