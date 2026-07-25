-- Migration: Update menstrual_settings and hydration_settings column names
-- Date: 2026-07-20

-- Update menstrual_settings table
ALTER TABLE menstrual_settings 
CHANGE COLUMN avg_cycle_length cycle_length_days INT NOT NULL DEFAULT 28;

-- Update hydration_settings table  
ALTER TABLE hydration_settings
CHANGE COLUMN measurement_error measurement_error_percent DECIMAL(5,2) NOT NULL DEFAULT 0.00;
