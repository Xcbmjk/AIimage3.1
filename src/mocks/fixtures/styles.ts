import type { StylePreset } from '../../types'

const scenicPortrait = (label: string, a: string, b: string, accent: string) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200" viewBox="0 0 900 1200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient><filter id="n"><feTurbulence baseFrequency=".7" numOctaves="3" stitchTiles="stitch"/><feColorMatrix values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 .12 0"/></filter></defs><rect width="900" height="1200" fill="url(#g)"/><path d="M0 850 Q180 560 340 790 T680 710 T900 820 V1200 H0Z" fill="#132f2a" opacity=".72"/><path d="M0 925 Q210 730 410 890 T900 815 V1200 H0Z" fill="${accent}" opacity=".42"/><circle cx="680" cy="250" r="120" fill="#f7e9bf" opacity=".78"/><circle cx="450" cy="520" r="160" fill="#f0d8b0" opacity=".2"/><path d="M450 345c-82 0-148 70-148 158 0 71 41 131 98 151l-28 227h156l-28-227c57-20 98-80 98-151 0-88-66-158-148-158Z" fill="#171d1c" opacity=".84"/><rect width="900" height="1200" filter="url(#n)" opacity=".75"/><text x="70" y="1030" fill="#f7e9bf" font-size="58" font-family="serif" letter-spacing="10">${label}</text><text x="74" y="1095" fill="#fff" opacity=".65" font-size="22" letter-spacing="6">MOUNTAIN PORTRAIT · 2026</text></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

export const demoPhoto = '/scenic-bg.jpg'

export const stylePresets: StylePreset[] = [
  {
    id: 'ink',
    name: '云山墨影',
    subtitle: '水墨写意',
    description: '留白、烟岚与淡墨，像一页徐徐展开的山水长卷。',
    prompt: '东方水墨人像表现，宣纸肌理、淡墨留白与克制的写意笔触，人物面部保持清晰可辨，人物和环境使用统一的水墨层次。',
    palette: ['#172f2a', '#b7b8aa', '#e9e2d2'],
    motif: '墨',
    resultImage: scenicPortrait('云山墨影', '#b6b7aa', '#e8e0cf', '#415c52'),
    mode: 'artistic',
  },
  {
    id: 'gold',
    name: '金陵绮梦',
    subtitle: '东方鎏金',
    description: '暖金晕染与古典纹样，定格盛装游园的华美瞬间。',
    prompt: '高质感东方电影旅拍，温暖金色调、自然皮肤纹理和细腻电影柔光，画面华美但保持真实摄影质感。',
    palette: ['#301f19', '#b47b3c', '#ead7a2'],
    motif: '金',
    resultImage: scenicPortrait('金陵绮梦', '#6b3527', '#d2a45c', '#d8b674'),
    mode: 'realistic',
  },
  {
    id: 'spring',
    name: '桃源春信',
    subtitle: '花朝映画',
    description: '桃花、春雾与柔光，走进古人笔下的隐世桃源。',
    prompt: '清新自然的旅行写真，柔和漫射光、通透空气感、自然肤色和轻盈色彩，呈现松弛真实的现场摄影效果。',
    palette: ['#455f49', '#c9857d', '#f0d2bd'],
    motif: '花',
    resultImage: scenicPortrait('桃源春信', '#7da08a', '#e2a69b', '#c97268'),
    mode: 'realistic',
  },
  {
    id: 'night',
    name: '星河夜游',
    subtitle: '国风幻境',
    description: '深蓝星夜与流光山河，营造梦境般的夜游奇遇。',
    prompt: '东方幻想绘卷表现，深蓝与金色流光、细腻轮廓光和梦境般层次，人物面部真实清晰，环境与人物风格统一。',
    palette: ['#17283f', '#476a82', '#c69e61'],
    motif: '夜',
    resultImage: scenicPortrait('星河夜游', '#17263e', '#3f6b79', '#b18a52'),
    mode: 'artistic',
  },
  {
    id: 'van-gogh',
    name: '梵高星梦',
    subtitle: '后印象油画',
    description: '旋转笔触、浓烈色彩与璀璨星空，化作富有生命力的油画肖像。',
    prompt: '后印象派油画表现，使用富有方向感的旋转笔触、浓郁蓝色与金黄色，但人物面部仍清晰可辨，人物与环境使用统一笔触、色彩和光线。',
    palette: ['#173f73', '#e5b53d', '#6f8b45'],
    motif: '星',
    resultImage: scenicPortrait('梵高星梦', '#173f73', '#e5b53d', '#6f8b45'),
    mode: 'artistic',
  },
]
