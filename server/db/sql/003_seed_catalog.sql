-- Initial published styles and pricing. Existing versions are never overwritten.

SET NAMES utf8mb4;

USE `aiaimage`;

INSERT INTO `style_versions` (
  `style_id`, `version`, `name`, `subtitle`, `description`, `prompt`,
  `cover_path`, `preview_data`, `palette_json`, `motif`, `mode`, `enabled`,
  `sort_order`, `status`, `created_at`, `published_at`
)
SELECT
  'ink', 1, '云山墨影', '水墨写意',
  '留白、烟岚与淡墨，像一页徐徐展开的山水长卷。',
  '东方水墨人像表现，宣纸肌理、淡墨留白与克制的写意笔触，人物面部保持清晰可辨，人物和环境使用统一的水墨层次。',
  NULL, NULL, '["#172f2a","#b7b8aa","#e9e2d2"]', '墨', 'artistic', 1, 0, 'published', UTC_TIMESTAMP(), UTC_TIMESTAMP()
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM `style_versions` WHERE `style_id` = 'ink' AND `version` = 1);

INSERT INTO `style_versions` (`style_id`, `version`, `name`, `subtitle`, `description`, `prompt`, `cover_path`, `preview_data`, `palette_json`, `motif`, `mode`, `enabled`, `sort_order`, `status`, `created_at`, `published_at`)
SELECT 'gold', 1, '金陵绮梦', '东方鎏金', '暖金晕染与古典纹样，定格盛装游园的华美瞬间。', '高质感东方电影旅拍，温暖金色调、自然皮肤纹理和细腻电影柔光，画面华美但保持真实摄影质感。', NULL, NULL, '["#301f19","#b47b3c","#ead7a2"]', '金', 'realistic', 1, 1, 'published', UTC_TIMESTAMP(), UTC_TIMESTAMP()
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `style_versions` WHERE `style_id` = 'gold' AND `version` = 1);

INSERT INTO `style_versions` (`style_id`, `version`, `name`, `subtitle`, `description`, `prompt`, `cover_path`, `preview_data`, `palette_json`, `motif`, `mode`, `enabled`, `sort_order`, `status`, `created_at`, `published_at`)
SELECT 'spring', 1, '桃源春信', '花朝映画', '桃花、春雾与柔光，走进古人笔下的隐世桃源。', '清新自然的旅行写真，柔和漫射光、通透空气感、自然肤色和轻盈色彩，呈现松弛真实的现场摄影效果。', NULL, NULL, '["#455f49","#c9857d","#f0d2bd"]', '花', 'realistic', 1, 2, 'published', UTC_TIMESTAMP(), UTC_TIMESTAMP()
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `style_versions` WHERE `style_id` = 'spring' AND `version` = 1);

INSERT INTO `style_versions` (`style_id`, `version`, `name`, `subtitle`, `description`, `prompt`, `cover_path`, `preview_data`, `palette_json`, `motif`, `mode`, `enabled`, `sort_order`, `status`, `created_at`, `published_at`)
SELECT 'night', 1, '星河夜游', '国风幻境', '深蓝星夜与流光山河，营造梦境般的夜游奇遇。', '东方幻想绘卷表现，深蓝与金色流光、细腻轮廓光和梦境般层次，人物面部真实清晰，环境与人物风格统一。', NULL, NULL, '["#17283f","#476a82","#c69e61"]', '夜', 'artistic', 1, 3, 'published', UTC_TIMESTAMP(), UTC_TIMESTAMP()
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `style_versions` WHERE `style_id` = 'night' AND `version` = 1);

INSERT INTO `style_versions` (`style_id`, `version`, `name`, `subtitle`, `description`, `prompt`, `cover_path`, `preview_data`, `palette_json`, `motif`, `mode`, `enabled`, `sort_order`, `status`, `created_at`, `published_at`)
SELECT 'van-gogh', 1, '梵高星梦', '后印象油画', '旋转笔触、浓烈色彩与璀璨星空，化作富有生命力的油画肖像。', '后印象派油画表现，使用富有方向感的旋转笔触、浓郁蓝色与金黄色，但人物面部仍清晰可辨，人物与环境使用统一笔触、色彩和光线。', NULL, NULL, '["#173f73","#e5b53d","#6f8b45"]', '星', 'artistic', 1, 4, 'published', UTC_TIMESTAMP(), UTC_TIMESTAMP()
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `style_versions` WHERE `style_id` = 'van-gogh' AND `version` = 1);

INSERT INTO `pricing_versions` (`amount_fen`, `description`, `status`, `created_at`, `published_at`)
SELECT 990, '焕新造像 AI 旅拍体验', 'published', UTC_TIMESTAMP(), UTC_TIMESTAMP()
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM `pricing_versions`);

INSERT IGNORE INTO `schema_migrations` (`version`)
VALUES ('003_seed_catalog_sql');
