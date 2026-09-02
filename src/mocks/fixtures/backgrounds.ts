import type { BackgroundPreset } from '../../types'

const backgroundPreview = (label: string, a: string, b: string, accent: string, pose: 'standing' | 'sitting' | 'walking') => {
  const figure = pose === 'sitting'
    ? '<g fill="#171d1c" opacity=".82"><circle cx="450" cy="470" r="62"/><path d="M450 540c-70 0-120 44-120 110v96h240v-96c0-66-50-110-120-110Z"/><rect x="300" y="720" width="300" height="70" rx="26"/><rect x="330" y="770" width="40" height="150" rx="18"/><rect x="530" y="770" width="40" height="150" rx="18"/></g>'
    : pose === 'walking'
      ? '<g fill="#171d1c" opacity=".82"><circle cx="452" cy="360" r="58"/><path d="M452 424c-58 0-98 40-98 98l-8 150h44l20-120 30 150 40-14 6-120 26 118 42-8-16-150c-4-52-40-104-86-104Z"/></g>'
      : '<g fill="#171d1c" opacity=".82"><circle cx="450" cy="360" r="60"/><path d="M450 428c-66 0-112 46-112 112v240h62V600h100v180h62V540c0-66-46-112-112-112Z"/></g>'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200" viewBox="0 0 900 1200"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient><filter id="n"><feTurbulence baseFrequency=".8" numOctaves="3" stitchTiles="stitch"/><feColorMatrix values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 .1 0"/></filter></defs><rect width="900" height="1200" fill="url(#g)"/><circle cx="640" cy="240" r="120" fill="#f7e9bf" opacity=".6"/><path d="M0 820 Q170 560 340 800 T680 720 T900 820 V1200 H0Z" fill="${accent}" opacity=".55"/><path d="M0 980 Q220 820 460 960 T900 900 V1200 H0Z" fill="#132f2a" opacity=".72"/>${figure}<rect width="900" height="1200" filter="url(#n)" opacity=".6"/><text x="70" y="1080" fill="#f7e9bf" font-size="54" font-family="serif" letter-spacing="10">${label}</text></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

export const backgroundPresets: BackgroundPreset[] = [
  {
    id: 'gate-steps',
    name: '门前石阶',
    subtitle: '坐姿 · 正面',
    description: '人物端坐于台阶中央，双手自然置于膝上，背景为对称建筑立面。',
    poseHint: '端坐姿态，身体正面朝向镜头，双手放松置于膝盖，双腿并拢微微侧向一边。',
    previewImage: backgroundPreview('门前石阶', '#7f9aa6', '#2b4a43', '#b07a48', 'sitting'),
  },
  {
    id: 'ridge-walk',
    name: '山脊漫步',
    subtitle: '行走 · 侧身',
    description: '人物侧身行走在山脊栈道上，一步向前，远景群山层叠。',
    poseHint: '侧身行走姿态，重心前移呈迈步状，双臂自然前后摆动，头部微转向镜头。',
    previewImage: backgroundPreview('山脊漫步', '#6f8f85', '#1c3b35', '#9c563f', 'walking'),
  },
  {
    id: 'lakeside-stand',
    name: '湖畔独立',
    subtitle: '站姿 · 正面',
    description: '人物安静伫立于湖边木栈道，湖面开阔，晨雾缭绕。',
    poseHint: '正面站立姿态，身体挺直放松，双手垂于身体两侧，目光平视远方。',
    previewImage: backgroundPreview('湖畔独立', '#7d97a3', '#22413a', '#c9a25e', 'standing'),
  },
]

export const demoBackground = backgroundPresets[0]
