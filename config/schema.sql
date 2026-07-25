-- =============================================================================
-- schema.sql
-- Derived from src/models/* and inline query snippets
-- =============================================================================

-- -----------------------------------------------------------------------------
-- users
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  username        VARCHAR(64)     NOT NULL,
  email           VARCHAR(255)    NOT NULL,
  password_hash   VARCHAR(255)    NOT NULL,
  name            VARCHAR(128)    NOT NULL,
  gender          ENUM('male','female')       DEFAULT NULL,
  height_cm       DECIMAL(5,2)               DEFAULT NULL,
  height_unit     ENUM('cm','ft')            DEFAULT 'cm',
  weight_unit     ENUM('kg','lbs')           DEFAULT 'kg',
  is_admin        TINYINT(1)      NOT NULL   DEFAULT 0,
  created_at      DATETIME        NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username (username),
  UNIQUE KEY uq_users_email    (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- exercises
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS exercises (
  id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  name            VARCHAR(255)    NOT NULL,
  muscle_group    VARCHAR(128)               DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_exercises_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- sessions
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  user_id         INT UNSIGNED    NOT NULL,
  day_number      INT             NOT NULL,
  day_title       VARCHAR(255)               DEFAULT NULL,
  muscle_groups   JSON                       DEFAULT NULL,   -- stored as JSON array
  person          VARCHAR(128)               DEFAULT NULL,
  start_time      DATETIME        NOT NULL,
  end_time        DATETIME                   DEFAULT NULL,
  total_duration  INT                        DEFAULT NULL,   -- seconds
  completed_sets  INT             NOT NULL   DEFAULT 0,
  is_admin        TINYINT(1)      NOT NULL   DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_sessions_user_id    (user_id),
  KEY idx_sessions_user_admin (user_id, is_admin),
  KEY idx_sessions_start_time (start_time),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- set_timings
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS set_timings (
  id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  session_id      INT UNSIGNED    NOT NULL,
  exercise_id     INT UNSIGNED    NOT NULL,
  exercise_index  INT                        DEFAULT NULL,   -- position within the day's exercise list (used by analytics)
  set_index       INT             NOT NULL,
  start_time      DATETIME        NOT NULL,
  end_time        DATETIME        NOT NULL,
  set_duration    INT                        DEFAULT NULL,   -- seconds
  rest_time       INT                        DEFAULT NULL,   -- seconds
  weight          DECIMAL(7,2)               DEFAULT NULL,
  reps            INT                        DEFAULT NULL,
  note            TEXT                       DEFAULT NULL,
  is_warmup       TINYINT(1)      NOT NULL   DEFAULT 0,
  created_at      DATETIME        NOT NULL   DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_st_session_id    (session_id),
  KEY idx_st_exercise_id   (exercise_id),
  KEY idx_st_exercise_index (session_id, exercise_id),
  CONSTRAINT fk_st_session  FOREIGN KEY (session_id)  REFERENCES sessions  (id) ON DELETE CASCADE,
  CONSTRAINT fk_st_exercise FOREIGN KEY (exercise_id) REFERENCES exercises (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- workout_programs
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workout_programs (
  user_id             INT UNSIGNED    NOT NULL,
  program_data        LONGTEXT        NOT NULL,   -- JSON (ProgramData)
  original_filename   VARCHAR(255)               DEFAULT NULL,
  uploaded_at         DATETIME        NOT NULL,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_wp_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- body_weight
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS body_weight (
  id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  user_id         INT UNSIGNED    NOT NULL,
  weight_kg       DECIMAL(6,2)    NOT NULL,
  recorded_at     DATETIME        NOT NULL,
  note            TEXT                       DEFAULT NULL,
  created_at      DATETIME        NOT NULL   DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_bw_user_recorded (user_id, recorded_at),
  CONSTRAINT fk_bw_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- body_fat_measurements
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS body_fat_measurements (
  id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  user_id         INT UNSIGNED    NOT NULL,
  percentage      DECIMAL(5,2)    NOT NULL,
  waist_cm        DECIMAL(5,2)               DEFAULT NULL,
  neck_cm         DECIMAL(5,2)               DEFAULT NULL,
  hip_cm          DECIMAL(5,2)               DEFAULT NULL,
  height_cm       DECIMAL(5,2)               DEFAULT NULL,
  gender          ENUM('male','female')       DEFAULT NULL,
  method          VARCHAR(64)                DEFAULT 'us_navy',
  calculated_at   DATETIME        NOT NULL,
  PRIMARY KEY (id),
  KEY idx_bfm_user_date (user_id, calculated_at),
  CONSTRAINT fk_bfm_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- supplements
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS supplements (
  id                          INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  user_id                     INT UNSIGNED    NOT NULL,
  name                        VARCHAR(255)    NOT NULL,
  unit                        VARCHAR(32)     NOT NULL   DEFAULT 'g',
  default_amount              DECIMAL(8,2)    NOT NULL   DEFAULT 5.00,
  reminder_enabled            TINYINT(1)      NOT NULL   DEFAULT 0,
  reminder_time               TIME                       DEFAULT NULL,
  location_reminder_enabled   TINYINT(1)      NOT NULL   DEFAULT 0,
  color                       VARCHAR(32)                DEFAULT NULL,
  icon                        VARCHAR(64)                DEFAULT NULL,
  created_at                  DATETIME        NOT NULL   DEFAULT CURRENT_TIMESTAMP,
  updated_at                  DATETIME        NOT NULL   DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sup_user (user_id),
  CONSTRAINT fk_sup_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- supplement_log
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS supplement_log (
  id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  supplement_id   INT UNSIGNED    NOT NULL,
  user_id         INT UNSIGNED    NOT NULL,
  amount          DECIMAL(8,2)    NOT NULL,
  taken_at        DATETIME        NOT NULL,
  note            TEXT                       DEFAULT NULL,
  created_at      DATETIME        NOT NULL   DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sl_user_supplement (user_id, supplement_id),
  KEY idx_sl_taken_at (taken_at),
  CONSTRAINT fk_sl_supplement FOREIGN KEY (supplement_id) REFERENCES supplements (id) ON DELETE CASCADE,
  CONSTRAINT fk_sl_user       FOREIGN KEY (user_id)       REFERENCES users        (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- supplement_locations
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS supplement_locations (
  id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  supplement_id   INT UNSIGNED    NOT NULL,
  user_id         INT UNSIGNED    NOT NULL,
  latitude        DECIMAL(10,7)   NOT NULL,
  longitude       DECIMAL(10,7)   NOT NULL,
  address         VARCHAR(512)    NOT NULL,
  radius          INT             NOT NULL   DEFAULT 100,   -- metres
  enabled         TINYINT(1)      NOT NULL   DEFAULT 1,
  created_at      DATETIME        NOT NULL   DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL   DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_suploc_supplement (supplement_id),          -- one location per supplement
  KEY idx_suploc_user (user_id),
  CONSTRAINT fk_suploc_supplement FOREIGN KEY (supplement_id) REFERENCES supplements (id) ON DELETE CASCADE,
  CONSTRAINT fk_suploc_user       FOREIGN KEY (user_id)       REFERENCES users        (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- progress_photos
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS progress_photos (
  id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  user_id         INT UNSIGNED    NOT NULL,
  photo_data      LONGBLOB        NOT NULL,
  mime_type       VARCHAR(64)     NOT NULL   DEFAULT 'image/jpeg',
  file_size       INT UNSIGNED    NOT NULL,
  taken_at        DATETIME        NOT NULL,
  note            TEXT                       DEFAULT NULL,
  created_at      DATETIME        NOT NULL   DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_pp_user_taken (user_id, taken_at),
  CONSTRAINT fk_pp_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- macros_goals
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS macros_goals (
  user_id         INT UNSIGNED    NOT NULL,
  protein_goal    DECIMAL(7,2)               DEFAULT 150.00,
  carbs_goal      DECIMAL(7,2)               DEFAULT 250.00,
  fat_goal        DECIMAL(7,2)               DEFAULT 65.00,
  calories_goal   DECIMAL(8,2)               DEFAULT 2000.00,
  updated_at      DATETIME                   DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_mg_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- macros_intake
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS macros_intake (
  id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  user_id         INT UNSIGNED    NOT NULL,
  name            VARCHAR(255)               DEFAULT NULL,
  protein         DECIMAL(7,2)               DEFAULT NULL,
  carbs           DECIMAL(7,2)               DEFAULT NULL,
  fat             DECIMAL(7,2)               DEFAULT NULL,
  calories        DECIMAL(8,2)               DEFAULT NULL,
  error_margin    DECIMAL(5,2)    NOT NULL   DEFAULT 0.00,  -- percentage
  time            VARCHAR(8)                 DEFAULT NULL,  -- HH:MM display label
  taken_at        DATETIME        NOT NULL,
  note            TEXT                       DEFAULT NULL,
  created_at      DATETIME        NOT NULL   DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_mi_user_taken (user_id, taken_at),
  CONSTRAINT fk_mi_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- protein_intake  (referenced in deleteUser cascade)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS protein_intake (
  id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  user_id         INT UNSIGNED    NOT NULL,
  grams           DECIMAL(6,2)    NOT NULL,
  recorded_at     DATETIME        NOT NULL,
  note            TEXT                       DEFAULT NULL,
  created_at      DATETIME        NOT NULL   DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_pi_user (user_id),
  CONSTRAINT fk_pi_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- friendships
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS friendships (
  id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  user_id         INT UNSIGNED    NOT NULL,
  friend_id       INT UNSIGNED    NOT NULL,
  status          ENUM('pending','accepted','declined') NOT NULL DEFAULT 'pending',
  created_at      DATETIME        NOT NULL,
  accepted_at     DATETIME                   DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_friendship (user_id, friend_id),
  KEY idx_fr_friend  (friend_id),
  KEY idx_fr_status  (status),
  CONSTRAINT fk_fr_user   FOREIGN KEY (user_id)   REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_fr_friend FOREIGN KEY (friend_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- sharing_permissions
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sharing_permissions (
  id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  from_user_id    INT UNSIGNED    NOT NULL,
  to_user_id      INT UNSIGNED    NOT NULL,
  permission_type ENUM('history','analytics','program','joint_session','watch_session') NOT NULL,
  payload         TEXT                       DEFAULT NULL,  -- JSON
  created_at      DATETIME        NOT NULL,
  updated_at      DATETIME        NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sp_triple (from_user_id, to_user_id, permission_type),
  KEY idx_sp_to   (to_user_id),
  CONSTRAINT fk_sp_from FOREIGN KEY (from_user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_sp_to   FOREIGN KEY (to_user_id)   REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- joint_sessions
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS joint_sessions (
  id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  status          ENUM('active','ended') NOT NULL DEFAULT 'active',
  created_at      DATETIME        NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- joint_session_participants
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS joint_session_participants (
  id                INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  joint_session_id  INT UNSIGNED  NOT NULL,
  user_id           INT UNSIGNED  NOT NULL,
  session_id        INT UNSIGNED               DEFAULT NULL,
  username          VARCHAR(64)                DEFAULT NULL,
  exercise_index    INT                        DEFAULT NULL,
  set_index         INT                        DEFAULT NULL,
  exercise_name     VARCHAR(255)               DEFAULT NULL,
  ready_for_next    TINYINT(1)    NOT NULL     DEFAULT 0,
  selected_person   VARCHAR(128)               DEFAULT NULL,
  exercise_names    TEXT                       DEFAULT NULL,  -- JSON array
  last_updated      DATETIME                   DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_jsp_participant (joint_session_id, user_id),
  KEY idx_jsp_user (user_id),
  CONSTRAINT fk_jsp_js   FOREIGN KEY (joint_session_id) REFERENCES joint_sessions (id) ON DELETE CASCADE,
  CONSTRAINT fk_jsp_user FOREIGN KEY (user_id)          REFERENCES users           (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- joint_session_invites
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS joint_session_invites (
  id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  from_user_id    INT UNSIGNED    NOT NULL,
  to_user_id      INT UNSIGNED    NOT NULL,
  from_session_id INT UNSIGNED               DEFAULT NULL,
  status          ENUM('pending','accepted','declined') NOT NULL DEFAULT 'pending',
  expires_at      DATETIME        NOT NULL,
  created_at      DATETIME        NOT NULL,
  PRIMARY KEY (id),
  KEY idx_jsi_to_status (to_user_id, status),
  KEY idx_jsi_from      (from_user_id),
  CONSTRAINT fk_jsi_from FOREIGN KEY (from_user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_jsi_to   FOREIGN KEY (to_user_id)   REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =============================================================================
-- NEW TRACKING FEATURES
-- =============================================================================

-- -----------------------------------------------------------------------------
-- body_measurements
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS body_measurements (
  id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  user_id         INT UNSIGNED    NOT NULL,
  waist_cm        DECIMAL(5,2)               DEFAULT NULL,
  arm_left_cm     DECIMAL(5,2)               DEFAULT NULL,
  arm_right_cm    DECIMAL(5,2)               DEFAULT NULL,
  chest_cm        DECIMAL(5,2)               DEFAULT NULL,
  measured_at     DATETIME        NOT NULL,
  note            TEXT                       DEFAULT NULL,
  created_at      DATETIME        NOT NULL   DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_bm_user_date (user_id, measured_at),
  CONSTRAINT fk_body_measurements_user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- hydration_log (water intake tracking)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hydration_log (
  id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  user_id         INT UNSIGNED    NOT NULL,
  amount_ml       DECIMAL(7,2)    NOT NULL,
  logged_at       DATETIME        NOT NULL,
  note            TEXT                       DEFAULT NULL,
  created_at      DATETIME        NOT NULL   DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_hl_user_date (user_id, logged_at),
  CONSTRAINT fk_hydration_log_user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- sleep_log (sleep duration and quality)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sleep_log (
  id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  user_id         INT UNSIGNED    NOT NULL,
  bedtime         DATETIME        NOT NULL,
  wake_time       DATETIME        NOT NULL,
  duration_hours  DECIMAL(4,2)               DEFAULT NULL,
  quality         ENUM('poor','fair','good','excellent') DEFAULT 'good',
  note            TEXT                       DEFAULT NULL,
  created_at      DATETIME        NOT NULL   DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sl_user_date (user_id, bedtime),
  CONSTRAINT fk_sleep_log_user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- muscle_soreness (DOMS) -- ADDED
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS muscle_soreness (
  id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  user_id         INT UNSIGNED    NOT NULL,
  muscle_group    VARCHAR(128)               NOT NULL,
  intensity       TINYINT                     NOT NULL,
  logged_at       DATETIME        NOT NULL,
  note            TEXT                       DEFAULT NULL,
  created_at      DATETIME        NOT NULL   DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ms_user_date (user_id, logged_at),
  CONSTRAINT fk_ms_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- menstrual_cycle -- ADDED
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS menstrual_cycle (
  id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  user_id         INT UNSIGNED    NOT NULL,
  cycle_start     DATETIME        NOT NULL,
  cycle_end       DATETIME                  DEFAULT NULL,
  duration_days   INT                        DEFAULT NULL,
  flow_intensity  ENUM('light','moderate','heavy') DEFAULT 'moderate',
  symptoms        TEXT                       DEFAULT NULL,
  created_at      DATETIME        NOT NULL   DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL   DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_mc_user_start (user_id, cycle_start),
  CONSTRAINT fk_mc_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
--