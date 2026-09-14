from __future__ import annotations

from ..catalog.seed import SeedStyle


def compose_portrait_prompt(style: SeedStyle) -> str:
    identity = (
        "以输入照片中的人物为唯一主角。严格保留人物可辨识身份，包括五官、脸型、肤色、"
        "年龄感和发型；不要生成第二个主要人物，不要改变种族或年龄。"
    )
    mode = (
        "这是写实旅拍模式。保持输入人物的原始姿势、身体朝向、肢体结构和人物比例；"
        "允许将服装自然调整为适合目的地的旅行穿着，但不得遮挡或重塑面部。"
        if style.mode == "realistic"
        else "这是艺术融合模式。严格保持人物面部身份，允许根据画面小幅调整姿势和服装；"
        "不得大幅改变体型，不得让艺术效果掩盖五官。"
    )
    composition = (
        "保持输入照片原始构图、背景、机位、透视、焦距、景深、光源方向、色温和环境细节，"
        "只对人物进行风格化处理；人物必须真实处于原环境中，禁止替换背景、添加景点、贴纸感、"
        "白边和悬浮感。"
    )
    quality = (
        "高质量完整画面，脸部清晰，眼睛自然，双手和肢体结构正确，无重复人物、无多余肢体、"
        "无文字、无标志、无水印。"
    )
    return "\n".join(
        (
            identity,
            mode,
            composition,
            f"表现风格：{style.name}。{style.prompt}",
            quality,
        )
    )
