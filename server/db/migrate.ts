import dotenv from 'dotenv'
import { loadConfig } from '../config'
import { createDatabase } from './mysql'

dotenv.config({ path: '.env.local' })
dotenv.config()
const run = async () => {
  const database = createDatabase(loadConfig())
  if (!database) throw new Error('MYSQL_ENABLED=true is required')
  await database.migrate()
  await database.close()
  console.log('MySQL schema is up to date')
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
