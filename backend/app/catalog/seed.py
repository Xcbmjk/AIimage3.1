from __future__ import annotations

from dataclasses import asdict, dataclass
from html import escape
from urllib.parse import quote


def _preview(label: str, first: str, second: str, accent: str) -> str:
    safe_label = escape(label)
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200" '
        'viewBox="0 0 900 1200">'
        f'<rect width="900" height="1200" fill="{first}"/>'
        f'<circle cx="680" cy="230" r="125" fill="{second}" opacity=".72"/>'
        f'<path d="M0 900 Q220 620 430 850 T900 780 V1200 H0Z" '
        f'fill="{accent}" opacity=".8"/>'
        '<path d="M0 980 Q230 760 460 930 T900 860 V1200 H0Z" '
        'fill="#132f2a" opacity=".76"/>'
        '<circle cx="450" cy="465" r="84" fill="#171d1c" opacity=".82"/>'
        '<path d="M450 550c-90 0-150 58-150 145v185h300V695c0-87-60-145-150-145Z" '
        'fill="#171d1c" opacity=".82"/>'
        f'<text x="70" y="1060" fill="#f7e9bf" font-size="54" '
        f'font-family="serif" letter-spacing="8">{safe_label}</text>'
        "</svg>"
    )
    return f"data:image/svg+xml;charset=utf-8,{quote(svg)}"


@dataclass(frozen=True)
class SeedStyle:
    id: str
    name: str
    subtitle: str
    description: str
    prompt: str
    palette: tuple[str, str, str]
    motif: str
    resultImage: str
    mode: str


@dataclass(frozen=True)
class SeedBackground:
    id: str
    name: str
    subtitle: str
    description: str
    poseHint: str
    previewImage: str
    imageMime: str = "image/jpeg"
    analysisPrompt: str | None = None


STYLE_PRESETS = (
    SeedStyle(
        id="ink",
        name="云山墨影",
        subtitle="水墨写意",
        description="留白、烟岚与淡墨，像一页徐徐展开的山水长卷。",
        prompt="东方水墨人像表现，宣纸肌理、淡墨留白与克制的写意笔触，人物面部保持清晰可辨，人物和环境使用统一的水墨层次。",
        palette=("#172f2a", "#b7b8aa", "#e9e2d2"),
        motif="墨",
        resultImage=_preview("云山墨影", "#b6b7aa", "#e8e0cf", "#415c52"),
        mode="artistic",
    ),
    SeedStyle(
        id="gold",
        name="金陵绮梦",
        subtitle="东方鎏金",
        description="暖金晕染与古典纹样，定格盛装游园的华美瞬间。",
        prompt="高质感东方电影旅拍，温暖金色调、自然皮肤纹理和细腻电影柔光，画面华美但保持真实摄影质感。",
        palette=("#301f19", "#b47b3c", "#ead7a2"),
        motif="金",
        resultImage=_preview("金陵绮梦", "#6b3527", "#d2a45c", "#d8b674"),
        mode="realistic",
    ),
    SeedStyle(
        id="spring",
        name="桃源春信",
        subtitle="花朝映画",
        description="桃花、春雾与柔光，走进古人笔下的隐世桃源。",
        prompt="清新自然的旅行写真，柔和漫射光、通透空气感、自然肤色和轻盈色彩，呈现松弛真实的现场摄影效果。",
        palette=("#455f49", "#c9857d", "#f0d2bd"),
        motif="花",
        resultImage=_preview("桃源春信", "#7da08a", "#e2a69b", "#c97268"),
        mode="realistic",
    ),
    SeedStyle(
        id="night",
        name="星河夜游",
        subtitle="国风幻境",
        description="深蓝星夜与流光山河，营造梦境般的夜游奇遇。",
        prompt="东方幻想绘卷表现，深蓝与金色流光、细腻轮廓光和梦境般层次，人物面部真实清晰，环境与人物风格统一。",
        palette=("#17283f", "#476a82", "#c69e61"),
        motif="夜",
        resultImage=_preview("星河夜游", "#17263e", "#3f6b79", "#b18a52"),
        mode="artistic",
    ),
    SeedStyle(
        id="van-gogh",
        name="梵高星梦",
        subtitle="后印象油画",
        description="旋转笔触、浓烈色彩与璀璨星空，化作富有生命力的油画肖像。",
        prompt="后印象派油画表现，使用富有方向感的旋转笔触、浓郁蓝色与金黄色，但人物面部仍清晰可辨，人物与环境使用统一笔触、色彩和光线。",
        palette=("#173f73", "#e5b53d", "#6f8b45"),
        motif="星",
        resultImage=_preview("梵高星梦", "#173f73", "#e5b53d", "#6f8b45"),
        mode="artistic",
    ),
)

BACKGROUND_PRESETS = (
    SeedBackground(
        id="gate-steps",
        name="门前石阶",
        subtitle="坐姿 · 正面",
        description="人物端坐于台阶中央，双手自然置于膝上，背景为对称建筑立面。",
        poseHint="端坐姿态，身体正面朝向镜头，双手放松置于膝盖，双腿并拢微微侧向一边。",
        previewImage=_preview("门前石阶", "#7f9aa6", "#2b4a43", "#b07a48"),
        analysisPrompt="端坐在画面中央，身体正面朝向镜头，双手放松置于膝盖，双腿并拢并略向一侧。人物与背景保持一致的正面机位和透视。",
    ),
    SeedBackground(
        id="ridge-walk",
        name="山脊漫步",
        subtitle="行走 · 侧身",
        description="人物侧身行走在山脊栈道上，一步向前，远景群山层叠。",
        poseHint="侧身行走姿态，重心前移呈迈步状，双臂自然前后摆动，头部微转向镜头。",
        previewImage=_preview("山脊漫步", "#6f8f85", "#1c3b35", "#9c563f"),
        analysisPrompt="人物侧身向前迈步，重心前移，双臂自然前后摆动，头部微转向镜头，位于山脊栈道的视觉中心。",
    ),
    SeedBackground(
        id="lakeside-stand",
        name="湖畔独立",
        subtitle="站姿 · 正面",
        description="人物安静伫立于湖边木栈道，湖面开阔，晨雾缭绕。",
        poseHint="正面站立姿态，身体挺直放松，双手垂于身体两侧，目光平视远方。",
        previewImage=_preview("湖畔独立", "#7d97a3", "#22413a", "#c9a25e"),
        analysisPrompt="人物正面站立，身体挺直而放松，双手自然垂落，目光平视远方，位于湖畔栈道中央并与晨雾景深融合。",
    ),
)


def style_public_dict(style: SeedStyle) -> dict[str, object]:
    data = asdict(style)
    data.pop("prompt", None)
    data["palette"] = list(style.palette)
    return data


def background_public_dict(background: SeedBackground) -> dict[str, object]:
    data = asdict(background)
    data["analysisPrompt"] = None
    return data
