-- Additional schema for new tracking features: menstrual settings, hydration settings, and custom measurements

-- menstrual_settings: stores user preferences for predicted cycle/period lengths
CREATE TABLE IF NOT EXISTS menstrual_settings (
  user_id           INT UNSIGNED    NOT NULL,
  period_days       INT             NOT NULL DEFAULT 5,
  cycle_length_days INT             NOT NULL DEFAULT 28,
  updated_at        DATETIME                   DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_ms_settings_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- hydration_settings: daily water goal (ml) and measurement error percentage
CREATE TABLE IF NOT EXISTS hydration_settings (
  user_id                  INT UNSIGNED    NOT NULL,
  goal_ml                  INT             NOT NULL DEFAULT 2000,
  measurement_error_percent DECIMAL(5,2)   NOT NULL DEFAULT 0.00,
  updated_at               DATETIME                    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_hyd_settings_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- measurement_custom_types: user-defined measurement kinds (e.g., thigh, neck)
CREATE TABLE IF NOT EXISTS measurement_custom_types (
  id          INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED    NOT NULL,
  key_name    VARCHAR(64)     NOT NULL,
  label       VARCHAR(128)    NOT NULL,
  unit        VARCHAR(32)                 DEFAULT NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_mct_user_key (user_id, key_name),
  CONSTRAINT fk_mct_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- measurement_custom_values: records for custom measurement types
CREATE TABLE IF NOT EXISTS measurement_custom_values (
  id          INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED    NOT NULL,
  type_id     INT UNSIGNED    NOT NULL,
  value       DECIMAL(10,4)   NOT NULL,
  measured_at DATETIME        NOT NULL,
  note        TEXT                       DEFAULT NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_mcv_user_date (user_id, measured_at),
  CONSTRAINT fk_mcv_type FOREIGN KEY (type_id) REFERENCES measurement_custom_types (id) ON DELETE CASCADE,
  CONSTRAINT fk_mcv_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- menstrual_day_flow: per-user, per-date persisted per-day flow intensity (light/moderate/heavy)
CREATE TABLE IF NOT EXISTS menstrual_day_flow (
  id            INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  user_id       INT UNSIGNED    NOT NULL,
  date          DATE            NOT NULL,
  intensity     ENUM('light','moderate','heavy') NOT NULL DEFAULT 'moderate',
  note          VARCHAR(255)                 DEFAULT NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_mdf_user_date (user_id, date),
  CONSTRAINT fk_mdf_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
