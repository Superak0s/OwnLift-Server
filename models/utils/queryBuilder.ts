// src/models/utils/queryBuilder.ts

type FilterValue = string | number | boolean | null | undefined

export interface WhereResult {
  whereClause: string
  params: FilterValue[]
}

export function buildWhereClause(
  filters: Record<string, FilterValue>,
  baseParams: FilterValue[] = [],
): WhereResult {
  const conditions: string[] = []
  const params: FilterValue[] = [...baseParams]

  for (const [key, value] of Object.entries(filters)) {
    if (value !== null && value !== undefined) {
      // Validate the identifier — values are parameterized, but column names
      // are interpolated and must never be attacker-controlled.
      conditions.push(`${sanitizeColumn(key)} = ?`)
      params.push(value)
    }
  }

  return {
    whereClause:
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  }
}

export interface PaginationResult {
  limitClause: string
  offset: number
  params: number[]
}

export function buildPagination(
  page = 1,
  pageSize = 20,
): PaginationResult {
  const offset = (page - 1) * pageSize
  return {
    limitClause: "LIMIT ? OFFSET ?",
    offset,
    params: [pageSize, offset],
  }
}

export function buildOrderBy(
  orderBy: string,
  direction: "ASC" | "DESC" = "DESC",
  allowedColumns: string[] = [],
): string {
  // Validate the column name before interpolating it into SQL.
  // allowedColumns should always be provided by callers that accept
  // user-influenced sort fields.
  const col = sanitizeColumn(orderBy, allowedColumns)
  const dir = (
    ["ASC", "DESC"].includes(direction.toUpperCase())
      ? direction.toUpperCase()
      : "DESC"
  ) as "ASC" | "DESC"
  return `ORDER BY ${col} ${dir}`
}

export interface ConditionResult {
  condition: string
  params: FilterValue[]
}

export function buildDateRange(
  column: string,
  startDate?: string,
  endDate?: string,
): ConditionResult {
  if (!startDate && !endDate) return { condition: "", params: [] }
  const col = sanitizeColumn(column)
  if (startDate && endDate)
    return {
      condition: `DATE(${col}) BETWEEN ? AND ?`,
      params: [startDate, endDate],
    }
  if (startDate) return { condition: `DATE(${col}) >= ?`, params: [startDate] }
  return { condition: `DATE(${col}) <= ?`, params: [endDate!] }
}

export function buildSearchCondition(
  columns: string[],
  searchTerm: string,
): ConditionResult {
  if (!searchTerm || columns.length === 0) return { condition: "", params: [] }
  return {
    condition: `(${columns.map((c) => `${sanitizeColumn(c)} LIKE ?`).join(" OR ")})`,
    params: columns.map(() => `%${searchTerm}%`),
  }
}

export function buildInClause(
  column: string,
  values: FilterValue[],
): ConditionResult {
  if (!values?.length) return { condition: "", params: [] }
  return {
    condition: `${sanitizeColumn(column)} IN (${values.map(() => "?").join(",")})`,
    params: values,
  }
}

export interface SelectQueryOptions {
  table: string
  columns?: string[]
  where?: Record<string, FilterValue>
  orderBy?: string
  orderDirection?: "ASC" | "DESC"
  allowedOrderColumns?: string[]
  limit?: number | null
  offset?: number | null
  joins?: string[]
}

export function buildSelectQuery({
  table,
  columns = ["*"],
  where = {},
  orderBy,
  orderDirection = "DESC",
  allowedOrderColumns = [],
  limit = null,
  offset = null,
  joins = [],
}: SelectQueryOptions): { query: string; params: FilterValue[] } {
  // Validate the table identifier defensively even though it is meant to be
  // caller-controlled (internal use only) — cheap insurance against a future
  // caller wiring user input through.
  let q = `SELECT ${columns.join(", ")} FROM ${sanitizeColumn(table)}`
  if (joins.length > 0) q += " " + joins.join(" ")

  const { whereClause, params } = buildWhereClause(where)
  if (whereClause) q += " " + whereClause

  if (orderBy) {
    // Enforce column allowlist when building ORDER BY to prevent SQL injection
    // if orderBy ever comes from user input.
    q += " " + buildOrderBy(orderBy, orderDirection, allowedOrderColumns)
  }

  const pagination: number[] = []
  if (limit !== null) {
    q += " LIMIT ?"
    pagination.push(limit)
    if (offset !== null) {
      q += " OFFSET ?"
      pagination.push(offset)
    }
  }

  return { query: q, params: [...params, ...pagination] }
}

export function buildUpdateQuery(
  table: string,
  updates: Record<string, FilterValue>,
  where: Record<string, FilterValue>,
): { query: string; params: FilterValue[] } {
  const setFields: string[] = []
  const setParams: FilterValue[] = []
  for (const [k, v] of Object.entries(updates)) {
    setFields.push(`${sanitizeColumn(k)} = ?`)
    setParams.push(v)
  }
  const { whereClause, params } = buildWhereClause(where, setParams)
  return {
    query: `UPDATE ${sanitizeColumn(table)} SET ${setFields.join(", ")} ${whereClause}`,
    params,
  }
}

export function buildInsertQuery(
  table: string,
  data: Record<string, FilterValue>,
): { query: string; params: FilterValue[] } {
  const cols = Object.keys(data).map((c) => sanitizeColumn(c))
  return {
    query: `INSERT INTO ${sanitizeColumn(table)} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    params: Object.values(data),
  }
}

/**
 * Validates a column name before interpolating it into SQL.
 * Always call this on any column name that could be influenced by user input.
 * If allowedColumns is provided, the name must be in the list AND match the
 * safe-identifier regex. If allowedColumns is empty, only the regex is checked.
 */
export function sanitizeColumn(
  column: string,
  allowedColumns: string[] = [],
): string {
  if (allowedColumns.length > 0 && !allowedColumns.includes(column))
    throw new Error(`Invalid column name: ${column}`)
  if (!/^[a-zA-Z0-9_.]+$/.test(column))
    throw new Error(`Invalid column name: ${column}`)
  return column
}
