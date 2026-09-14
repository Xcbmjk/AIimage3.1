# Historical MySQL 5.7 SQL scripts

These files belong to the retired Node/Express runtime. The active runtime uses
the Alembic migrations under `backend/app/db/migrations/versions/`; do not use
these SQL files for a new deployment.

These scripts target the `aiaimage` database and do not contain server addresses,
database passwords, administrator passwords, or application secrets.

## Execution order

For a new database, run:

```bash
mysql -h <host> -P 3306 -u <admin-user> -p < server/db/sql/001_schema.sql
mysql -h <host> -P 3306 -u <admin-user> -p < server/db/sql/003_seed_catalog.sql
```

For a database created by an older project version, back it up and run:

```bash
mysql -h <host> -P 3306 -u <admin-user> -p < server/db/sql/001_schema.sql
mysql -h <host> -P 3306 -u <admin-user> -p < server/db/sql/002_upgrade_payment.sql
mysql -h <host> -P 3306 -u <admin-user> -p < server/db/sql/003_seed_catalog.sql
```

Before running `002_upgrade_payment.sql`, check for data that would conflict with
the new unique indexes:

```sql
USE `aiaimage`;

SELECT `transaction_id`, COUNT(*) AS `duplicate_count`
FROM `orders`
WHERE `transaction_id` IS NOT NULL
GROUP BY `transaction_id`
HAVING COUNT(*) > 1;

SELECT `order_id`, COUNT(*) AS `duplicate_count`
FROM `generation_jobs`
GROUP BY `order_id`
HAVING COUNT(*) > 1;
```

Both queries must return no rows. Resolve any conflicts and take a fresh backup
before continuing. Adding indexes or modifying the order status enum can lock the
affected tables, so run the upgrade during a maintenance window.

`001_schema.sql` uses `CREATE TABLE IF NOT EXISTS`. `002_upgrade_payment.sql`
checks `information_schema` before adding columns and indexes. `003_seed_catalog.sql`
only inserts missing style versions and inserts default pricing only when the pricing
table is empty.

The initial style seed intentionally leaves preview images empty. Upload JPG, PNG,
or WebP covers in the admin style editor after installation.

## Verification

```sql
USE `aiaimage`;

SELECT `version`, `applied_at`
FROM `schema_migrations`
ORDER BY `applied_at`, `version`;

SELECT COUNT(*) AS `style_count`
FROM `style_versions`
WHERE `status` = 'published' AND `enabled` = 1;

SELECT `amount_fen`, `description`, `status`
FROM `pricing_versions`
ORDER BY `id` DESC;

SHOW INDEX FROM `orders` WHERE `Key_name` = 'uq_orders_transaction';
SHOW INDEX FROM `generation_jobs` WHERE `Key_name` = 'uq_generation_order';
SHOW TABLES LIKE 'payment_notifications';
```

After SQL execution, keep the application configuration aligned:

```dotenv
MYSQL_ENABLED=true
MYSQL_HOST=<host>
MYSQL_PORT=3306
MYSQL_USER=<application-user>
MYSQL_PASSWORD=<application-password>
MYSQL_DATABASE=aiaimage
```

For the active runtime, use:

```bash
python -m alembic -c backend/alembic.ini upgrade head
python -m backend.app.admin_cli import-legacy --input <legacy-json>
```
