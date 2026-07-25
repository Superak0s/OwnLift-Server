import { pool } from '../config/database'

async function runMigration() {
  try {
    console.log('Running migration: Fix tracking column names...')
    
    // Update menstrual_settings table
    console.log('Updating menstrual_settings table...')
    await pool.execute(
      'ALTER TABLE menstrual_settings CHANGE COLUMN avg_cycle_length cycle_length_days INT NOT NULL DEFAULT 28'
    )
    console.log('✓ menstrual_settings updated')
    
    // Update hydration_settings table
    console.log('Updating hydration_settings table...')
    await pool.execute(
      'ALTER TABLE hydration_settings CHANGE COLUMN measurement_error measurement_error_percent DECIMAL(5,2) NOT NULL DEFAULT 0.00'
    )
    console.log('✓ hydration_settings updated')
    
    console.log('\n✅ Migration completed successfully!')
    process.exit(0)
  } catch (error) {
    console.error('❌ Migration failed:', error)
    process.exit(1)
  }
}

runMigration()
