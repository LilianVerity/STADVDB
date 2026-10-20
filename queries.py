"""OLAP query builders for the finance_mco1 star schema.

Every public function returns an OlapQuery (SQL text + bound parameters).
The dashboard (streamlit_app.py) and the functional tests (tests/) both use
these builders, so the SQL that is tested is exactly the SQL the dashboard runs.

Safety: user-chosen values (years, regions, amounts, ...) are always passed as
bound parameters (%s). User-chosen *structure* (levels, measures, hierarchies)
is validated against the whitelists below and never inserted as raw text.
Invalid parameters raise ValueError.
"""
from dataclasses import dataclass, field
import datetime as dt
import re

# ---------------------------------------------------------------- dimensions
DIMENSION_JOINS = {
    "d":  "JOIN `date` d                  ON d.date_key = f.date_key",
    "a":  "JOIN account a                 ON a.account_key = f.account_key",
    "tt": "JOIN transaction_type tt       ON tt.type_key = f.type_key",
    "op": "JOIN transaction_operation op  ON op.operation_key = f.operation_key",
}


def star_from(*parts):
    """FROM clause of the star join, joining only the dimension tables that the
    given SQL fragments reference (each unused join costs ~1M lookups)."""
    text = " ".join(p if isinstance(p, str) else " ".join(p) for p in parts)
    joins = [j for alias, j in DIMENSION_JOINS.items() if re.search(rf"\b{alias}\.", text)]
    return "\n".join(["FROM transaction_fact f"] + joins)


def select_kw(clauses):
    """SELECT keyword with an optimizer hint for unfiltered queries.
    Without filters, scanning the fact table first and looking up the small
    dimensions is ~2x faster than MySQL's default plan (which drives from the
    dimension and does random index lookups into the fact table). With
    selective filters the default plan is better, so no hint is added."""
    return "SELECT" if clauses else "SELECT /*+ JOIN_PREFIX(f) */"


@dataclass(frozen=True)
class Level:
    name: str            # column name in results
    title: str           # display name
    dimension: str       # time / location / transaction / account
    key: str             # SQL expression used for grouping/filtering
    label: str = None    # optional SQL expression for a display label
    value_type: type = str


LEVELS = {
    "year":      Level("year", "Year", "time", "d.year_number", value_type=int),
    "quarter":   Level("quarter", "Quarter", "time", "d.quarter_number", value_type=int),
    "month":     Level("month", "Month", "time", "d.month_number", "d.month_name", int),
    "day":       Level("day", "Day", "time", "d.full_date", value_type=dt.date),
    "region":    Level("region", "Region", "location", "a.region"),
    "district":  Level("district", "District", "location", "a.district_name"),
    "account":   Level("account", "Account", "location", "a.account_id", value_type=int),
    "type":      Level("type", "Transaction type", "transaction", "tt.transaction_type"),
    "operation": Level("operation", "Operation", "transaction", "op.operation_name"),
    "frequency": Level("frequency", "Statement frequency", "account", "a.account_frequency"),
}

HIERARCHIES = {
    "time":        ["year", "quarter", "month", "day"],
    "location":    ["region", "district", "account"],
    "transaction": ["type", "operation"],
}

# Levels with few members: allowed as pivot columns.
PIVOT_COLUMN_LEVELS = ["year", "quarter", "month", "region", "type", "operation", "frequency"]
PIVOT_ROW_LEVELS = PIVOT_COLUMN_LEVELS + ["district"]

# ---------------------------------------------------------------- measures
CREDIT = "Credit"
DEBIT = "Debit (Withdrawal)"


@dataclass(frozen=True)
class Measure:
    name: str
    title: str
    agg: str      # SUM / AVG / COUNT / COUNT_DISTINCT
    expr: str


MEASURES = {
    "txn_count":       Measure("txn_count", "Number of transactions", "COUNT", "1"),
    "total_amount":    Measure("total_amount", "Total amount", "SUM", "f.amount"),
    "avg_amount":      Measure("avg_amount", "Average amount", "AVG", "f.amount"),
    "total_credit":    Measure("total_credit", "Total credits", "SUM",
                               f"CASE WHEN tt.transaction_type = '{CREDIT}' THEN f.amount ELSE 0 END"),
    "total_debit":     Measure("total_debit", "Total debits", "SUM",
                               f"CASE WHEN tt.transaction_type = '{DEBIT}' THEN f.amount ELSE 0 END"),
    "net_flow":        Measure("net_flow", "Net flow (credits - debits)", "SUM",
                               f"CASE WHEN tt.transaction_type = '{CREDIT}' THEN f.amount "
                               f"WHEN tt.transaction_type = '{DEBIT}' THEN -f.amount ELSE 0 END"),
    "active_accounts": Measure("active_accounts", "Active accounts", "COUNT_DISTINCT", "f.account_key"),
    # balance is semi-additive (a running snapshot) so it is averaged, never summed
    "avg_balance":     Measure("avg_balance", "Average balance after transaction", "AVG", "f.balance"),
}
DEFAULT_MEASURES = ["txn_count", "total_amount", "total_credit", "total_debit", "net_flow"]


def measure_sql(m, cond=None):
    """Aggregate SQL for a measure, optionally restricted by a condition
    (conditional aggregation, used by the pivot)."""
    if m.agg == "COUNT":
        return "COUNT(*)" if cond is None else f"COUNT(CASE WHEN {cond} THEN 1 END)"
    if m.agg == "COUNT_DISTINCT":
        inner = m.expr if cond is None else f"CASE WHEN {cond} THEN {m.expr} END"
        return f"COUNT(DISTINCT {inner})"
    if m.agg == "SUM":
        inner = m.expr if cond is None else f"CASE WHEN {cond} THEN {m.expr} ELSE 0 END"
        return f"ROUND(SUM({inner}), 2)"
    if m.agg == "AVG":
        inner = m.expr if cond is None else f"CASE WHEN {cond} THEN {m.expr} END"
        return f"ROUND(AVG({inner}), 2)"
    raise ValueError(f"unsupported aggregate {m.agg}")


# ---------------------------------------------------------------- query object
@dataclass
class OlapQuery:
    operation: str
    sql: str
    params: list = field(default_factory=list)
    description: str = ""
    level_columns: list = field(default_factory=list)   # dimension columns in the result
    measure_columns: list = field(default_factory=list)


# ---------------------------------------------------------------- validation
def _level(name):
    if name not in LEVELS:
        raise ValueError(f"unknown level '{name}'. Valid levels: {', '.join(LEVELS)}")
    return LEVELS[name]


def _hierarchy(name):
    if name not in HIERARCHIES:
        raise ValueError(f"unknown hierarchy '{name}'. Valid: {', '.join(HIERARCHIES)}")
    return HIERARCHIES[name]


def _measures(names):
    names = list(names or DEFAULT_MEASURES)
    if not names:
        raise ValueError("at least one measure is required")
    bad = [n for n in names if n not in MEASURES]
    if bad:
        raise ValueError(f"unknown measure(s) {bad}. Valid: {', '.join(MEASURES)}")
    return [MEASURES[n] for n in dict.fromkeys(names)]


def _coerce(level, value):
    """Convert a user-supplied member value to the level's type."""
    if value is None or (isinstance(value, str) and value.strip() == ""):
        raise ValueError(f"a value for {level.title} is required")
    try:
        if level.value_type is int:
            if isinstance(value, bool) or (isinstance(value, float) and not value.is_integer()):
                raise ValueError
            return int(value)
        if level.value_type is dt.date:
            return value if isinstance(value, dt.date) else dt.date.fromisoformat(str(value))
        return str(value)
    except (TypeError, ValueError):
        raise ValueError(f"invalid value {value!r} for {level.title} "
                         f"(expected {level.value_type.__name__})") from None


def _measure_select(measures):
    return [f"{measure_sql(m)} AS {m.name}" for m in measures]


def _level_select(level, rollup=False):
    """SELECT items for a level: key column plus optional label column."""
    items = [f"{level.key} AS `{level.name}`"]
    if level.label:
        label = f"MAX({level.label})"
        if rollup:
            label = f"IF(GROUPING({level.key}) = 1, NULL, {label})"
        items.append(f"{label} AS `{level.name}_name`")
    return items


def _level_columns(levels):
    cols = []
    for lv in levels:
        cols.append(lv.name)
        if lv.label:
            cols.append(f"{lv.name}_name")
    return cols


def _sql(*parts):
    return "\n".join(p for p in parts if p)


def _indent(items, sep=",\n    "):
    return "    " + sep.join(items)


# ---------------------------------------------------------------- filters
FILTER_KEYS = {
    # key: (dimension, kind, sql expression)
    "year_from":   ("time", "min", "d.year_number"),
    "year_to":     ("time", "max", "d.year_number"),
    "date_from":   ("time", "min_date", "d.full_date"),
    "date_to":     ("time", "max_date", "d.full_date"),
    "quarters":    ("time", "in_int", "d.quarter_number"),
    "months":      ("time", "in_int", "d.month_number"),
    "regions":     ("location", "in", "a.region"),
    "districts":   ("location", "in", "a.district_name"),
    "types":       ("transaction", "in", "tt.transaction_type"),
    "operations":  ("transaction", "in", "op.operation_name"),
    "frequencies": ("account", "in", "a.account_frequency"),
    "amount_min":  ("amount", "min_num", "f.amount"),
    "amount_max":  ("amount", "max_num", "f.amount"),
}


def build_filters(filters):
    """Translate a filter dict into (where_clauses, params, dimensions_used).
    Empty / None values mean "no filter" for that key."""
    filters = filters or {}
    unknown = set(filters) - set(FILTER_KEYS)
    if unknown:
        raise ValueError(f"unknown filter(s) {sorted(unknown)}. Valid: {', '.join(FILTER_KEYS)}")

    clauses, params, dims = [], [], set()
    for key, (dim, kind, expr) in FILTER_KEYS.items():
        value = filters.get(key)
        if value is None or (isinstance(value, (list, tuple, set)) and len(value) == 0):
            continue
        if kind in ("min", "max"):
            try:
                value = int(value)
            except (TypeError, ValueError):
                raise ValueError(f"{key} must be a year (integer), got {value!r}") from None
            clauses.append(f"{expr} {'>=' if kind == 'min' else '<='} %s")
        elif kind in ("min_date", "max_date"):
            try:
                value = value if isinstance(value, dt.date) else dt.date.fromisoformat(str(value))
            except ValueError:
                raise ValueError(f"{key} must be a date (YYYY-MM-DD), got {value!r}") from None
            clauses.append(f"{expr} {'>=' if kind == 'min_date' else '<='} %s")
        elif kind in ("min_num", "max_num"):
            try:
                value = float(value)
            except (TypeError, ValueError):
                raise ValueError(f"{key} must be a number, got {value!r}") from None
            if value < 0:
                raise ValueError(f"{key} cannot be negative")
            clauses.append(f"{expr} {'>=' if kind == 'min_num' else '<='} %s")
        elif kind in ("in", "in_int"):
            values = list(value) if isinstance(value, (list, tuple, set)) else [value]
            if kind == "in_int":
                try:
                    values = [int(v) for v in values]
                except (TypeError, ValueError):
                    raise ValueError(f"{key} must contain integers, got {value!r}") from None
            else:
                values = [str(v) for v in values]
            clauses.append(f"{expr} IN ({', '.join(['%s'] * len(values))})")
            params.extend(values)
            dims.add(dim)
            continue
        params.append(value)
        dims.add(dim)

    def check_range(lo, hi, label):
        a, b = filters.get(lo), filters.get(hi)
        if a is not None and b is not None and a > b:
            raise ValueError(f"invalid {label} range: {lo} ({a}) is greater than {hi} ({b})")

    check_range("year_from", "year_to", "year")
    check_range("date_from", "date_to", "date")
    if filters.get("amount_min") is not None and filters.get("amount_max") is not None:
        if float(filters["amount_min"]) > float(filters["amount_max"]):
            raise ValueError("invalid amount range: amount_min is greater than amount_max")
    return clauses, params, dims


def _where(clauses):
    return "WHERE " + "\n  AND ".join(clauses) if clauses else ""


# ================================================================= ROLL-UP
def rollup(hierarchy, level, measures=None, filters=None):
    """Aggregate from `level` up through every coarser level of the hierarchy
    to a grand total, using GROUP BY ... WITH ROLLUP and GROUPING()."""
    path = _hierarchy(hierarchy)
    if level not in path:
        raise ValueError(f"level '{level}' is not part of the {hierarchy} hierarchy {path}")
    levels = [LEVELS[n] for n in path[: path.index(level) + 1]]
    ms = _measures(measures)
    clauses, params, _ = build_filters(filters)

    select = []
    for lv in levels:
        select += _level_select(lv, rollup=True)
    case = ["CASE"]
    case.append(f"        WHEN GROUPING({levels[0].key}) = 1 THEN 'All'")
    for parent, child in zip(levels, levels[1:]):
        case.append(f"        WHEN GROUPING({child.key}) = 1 THEN '{parent.title}'")
    case.append(f"        ELSE '{levels[-1].title}'\n    END AS aggregation_level")
    select.append("\n".join(case))
    select += _measure_select(ms)

    order = []
    for lv in levels:
        order += [f"GROUPING({lv.key})", lv.key]

    sql = _sql(
        select_kw(clauses),
        _indent(select),
        star_from(select, clauses),
        _where(clauses),
        "GROUP BY " + ", ".join(lv.key for lv in levels) + " WITH ROLLUP",
        "ORDER BY " + ", ".join(order),
    )
    return OlapQuery("Roll-up", sql, params,
                     f"Roll-up of the {hierarchy} hierarchy from {levels[-1].title} "
                     f"up to {' > '.join(lv.title for lv in reversed(levels[:-1]))}"
                     f"{' > ' if len(levels) > 1 else ''}grand total",
                     _level_columns(levels) + ["aggregation_level"], [m.name for m in ms])


# ================================================================= DRILL-DOWN
def drilldown(hierarchy, path_values=None, measures=None, filters=None):
    """Show the children of a member of a hierarchy. path_values lists the
    selected member at each level from the top, e.g. [1997, 2] in the time
    hierarchy = 1997 Q2, whose children are its months."""
    path = _hierarchy(hierarchy)
    path_values = list(path_values or [])
    if len(path_values) >= len(path):
        raise ValueError(f"cannot drill below '{path[-1]}', the finest level of {hierarchy}")
    names = list(dict.fromkeys(["txn_count", "total_amount"] + list(measures or DEFAULT_MEASURES)))
    ms = _measures(names)
    parents = [LEVELS[n] for n in path[: len(path_values)]]
    child = LEVELS[path[len(path_values)]]

    clauses, params = [], []
    for lv, value in zip(parents, path_values):
        clauses.append(f"{lv.key} = %s")
        params.append(_coerce(lv, value))
    f_clauses, f_params, _ = build_filters(filters)
    clauses += f_clauses
    params += f_params

    is_time = hierarchy == "time"
    window_order = f"c.`{child.name}`"
    extra = [
        "ROUND(100 * c.total_amount / NULLIF(SUM(c.total_amount) OVER (), 0), 2) AS pct_of_parent_amount",
        "RANK() OVER (ORDER BY c.total_amount DESC) AS amount_rank",
    ]
    if is_time:
        extra += [
            "LAG(c.total_amount) OVER w AS prev_total_amount",
            "ROUND(100 * (c.total_amount - LAG(c.total_amount) OVER w)"
            " / NULLIF(LAG(c.total_amount) OVER w, 0), 2) AS pct_change_vs_prev",
        ]
    inner = _level_select(child) + _measure_select(ms)
    sql = _sql(
        "WITH children AS (",
        "    " + select_kw(clauses),
        "    " + _indent(inner, sep=",\n        "),
        "    " + star_from(inner, clauses).replace("\n", "\n    "),
        "    " + _where(clauses).replace("\n", "\n    ") if clauses else "",
        f"    GROUP BY {child.key}",
        ")",
        "SELECT",
        _indent(["c.*"] + extra),
        "FROM children c",
        f"WINDOW w AS (ORDER BY {window_order})" if is_time else "",
        f"ORDER BY {window_order if is_time else 'c.total_amount DESC'}",
    )
    crumb = " > ".join(f"{lv.title} {v}" for lv, v in zip(parents, path_values)) or "All"
    return OlapQuery("Drill-down", sql, params,
                     f"Drill-down from [{crumb}] to {child.title} level",
                     _level_columns([child]),
                     [m.name for m in ms])


# ================================================================= SLICE
def slice_(level, value, by_level, measures=None):
    """Fix ONE dimension member (e.g. year = 1997) and analyse the resulting
    sub-cube along another level."""
    lv = _level(level)
    by = _level(by_level)
    if level == by_level:
        raise ValueError("the slice level and the 'view by' level must be different")
    value = _coerce(lv, value)
    names = list(dict.fromkeys(["txn_count", "total_amount"] + list(measures or DEFAULT_MEASURES)))
    ms = _measures(names)

    is_time = by.dimension == "time"
    extra = ["ROUND(100 * s.total_amount / NULLIF(SUM(s.total_amount) OVER (), 0), 2)"
             " AS pct_of_slice_amount"]
    if is_time:
        extra.append(f"SUM(s.total_amount) OVER (ORDER BY s.`{by.name}` "
                     "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_total_amount")
    else:
        extra.append("RANK() OVER (ORDER BY s.total_amount DESC) AS amount_rank")
    inner = _level_select(by) + _measure_select(ms)
    sql = _sql(
        "WITH slice AS (",
        "    SELECT",
        "    " + _indent(inner, sep=",\n        "),
        "    " + star_from(inner, lv.key).replace("\n", "\n    "),
        f"    WHERE {lv.key} = %s",
        f"    GROUP BY {by.key}",
        ")",
        "SELECT",
        _indent(["s.*"] + extra),
        "FROM slice s",
        f"ORDER BY s.`{by.name}`" if is_time else "ORDER BY s.total_amount DESC",
    )
    return OlapQuery("Slice", sql, [value],
                     f"Slice {lv.title} = {value}, viewed by {by.title}",
                     _level_columns([by]), [m.name for m in ms])


# ================================================================= DICE
def dice(filters, by_level, measures=None, by_level2=None):
    """Select a sub-cube using conditions on TWO OR MORE dimensions
    (values and/or ranges) and summarise it by one or two levels."""
    clauses, params, dims = build_filters(filters)
    if len(dims) < 2:
        raise ValueError("dice needs filters on at least two different dimensions "
                         f"(got: {sorted(dims) or 'none'}); use slice for a single dimension")
    by = [_level(by_level)]
    if by_level2:
        if by_level2 == by_level:
            raise ValueError("the two 'group by' levels must be different")
        by.append(_level(by_level2))
    names = list(dict.fromkeys(["txn_count", "total_amount"] + list(measures or DEFAULT_MEASURES)))
    ms = _measures(names)

    select = []
    for lv in by:
        select += _level_select(lv)
    if len(by) == 2:
        part = f"PARTITION BY s.`{by[0].name}` "
        extra = [
            f"RANK() OVER ({part}ORDER BY s.total_amount DESC) AS rank_within_{by[0].name}",
            f"ROUND(100 * s.total_amount / NULLIF(SUM(s.total_amount) OVER ({part.strip()}), 0), 2)"
            f" AS pct_within_{by[0].name}",
        ]
    else:
        extra = [
            "RANK() OVER (ORDER BY s.total_amount DESC) AS amount_rank",
            "ROUND(100 * s.total_amount / NULLIF(SUM(s.total_amount) OVER (), 0), 2)"
            " AS pct_of_dice_amount",
        ]
    sql = _sql(
        "WITH diced AS (",
        "    SELECT",
        "    " + _indent(select + _measure_select(ms), sep=",\n        "),
        "    " + star_from(select, _measure_select(ms), clauses).replace("\n", "\n    "),
        "    " + _where(clauses).replace("\n", "\n    "),
        "    GROUP BY " + ", ".join(lv.key for lv in by),
        ")",
        "SELECT",
        _indent(["s.*"] + extra),
        "FROM diced s",
        "ORDER BY " + ", ".join(f"s.`{lv.name}`" for lv in by),
    )
    return OlapQuery("Dice", sql, params,
                     f"Dice on {', '.join(sorted(dims))} grouped by "
                     f"{' x '.join(lv.title for lv in by)}",
                     _level_columns(by), [m.name for m in ms])


# ================================================================= PIVOT
def pivot_columns_query(col_level, filters=None):
    """Query returning the members of the pivot column level (in order)."""
    col = _level(col_level)
    clauses, params, _ = build_filters(filters)
    label = f"MAX({col.label})" if col.label else col.key
    sql = _sql(
        f"{select_kw(clauses)} {col.key} AS col_key, {label} AS col_label",
        star_from(col.key, clauses),
        _where(clauses),
        f"GROUP BY {col.key}",
        f"ORDER BY {col.key}",
    )
    return sql, params


def pivot(row_level, col_level, measure, col_members, filters=None):
    """Rotate the cube: one row per member of row_level, one column per
    member of col_level (conditional aggregation), plus row/column totals.
    col_members is a list of (key, label) pairs - normally the result of
    pivot_columns_query()."""
    if row_level not in PIVOT_ROW_LEVELS:
        raise ValueError(f"'{row_level}' cannot be used as pivot rows. Valid: {PIVOT_ROW_LEVELS}")
    if col_level not in PIVOT_COLUMN_LEVELS:
        raise ValueError(f"'{col_level}' cannot be used as pivot columns "
                         f"(too many members). Valid: {PIVOT_COLUMN_LEVELS}")
    if row_level == col_level:
        raise ValueError("pivot rows and columns must be different levels")
    row, col = LEVELS[row_level], LEVELS[col_level]
    m = _measures([measure])[0]
    if not col_members:
        raise ValueError("pivot has no column members (the filters may exclude all data)")
    clauses, f_params, _ = build_filters(filters)

    row_label = f"MAX({row.label})" if row.label else row.key
    select = [
        f"IF(GROUPING({row.key}) = 1, 'Total', CAST({row_label} AS CHAR)) AS `{row.name}`",
    ]
    params, columns = [], []
    for key, label in col_members:
        alias = f"Q{label}" if col_level == "quarter" else str(label)
        alias = alias.replace("`", "``")[:64]
        select.append(f"{measure_sql(m, f'{col.key} = %s')} AS `{alias}`")
        params.append(_coerce(col, key))
        columns.append(alias)
    select.append(f"{measure_sql(m)} AS `Total`")
    sql = _sql(
        select_kw(clauses),
        _indent(select),
        star_from(select, clauses),
        _where(clauses),
        f"GROUP BY {row.key} WITH ROLLUP",
        f"ORDER BY GROUPING({row.key}), {row.key}",
    )
    return OlapQuery("Pivot", sql, params + f_params,
                     f"Pivot of {m.title}: {row.title} (rows) x {col.title} (columns)",
                     [row.name], columns + ["Total"])


# ================================================================= helpers for the UI
def members_query(level):
    """Distinct members of a level that actually have facts (for dropdowns)."""
    lv = _level(level)
    if lv.dimension == "time":
        label = f", MAX({lv.label}) AS label" if lv.label else ""
        return f"SELECT {lv.key} AS member{label} FROM `date` d GROUP BY {lv.key} ORDER BY {lv.key}"
    table, alias, pk, fk = {
        "location": ("account", "a", "account_key", "account_key"),
        "account": ("account", "a", "account_key", "account_key"),
        "transaction": ("transaction_type", "tt", "type_key", "type_key")
        if level == "type" else ("transaction_operation", "op", "operation_key", "operation_key"),
    }[lv.dimension]
    return (f"SELECT DISTINCT {lv.key} AS member FROM {table} {alias} "
            f"WHERE EXISTS (SELECT 1 FROM transaction_fact f WHERE f.{fk} = {alias}.{pk}) "
            f"ORDER BY member")


def overview_query():
    return _sql(
        "SELECT",
        _indent(["COUNT(*) AS txn_count",
                 "ROUND(SUM(f.amount), 2) AS total_amount",
                 "COUNT(DISTINCT f.account_key) AS active_accounts",
                 "MIN(d.full_date) AS first_date",
                 "MAX(d.full_date) AS last_date"]),
        "FROM transaction_fact f",
        "JOIN `date` d ON d.date_key = f.date_key",
    )


def location_members_query():
    """Region -> district pairs that have facts (for cascading filters)."""
    return ("SELECT DISTINCT a.region, a.district_name AS district FROM account a "
            "WHERE EXISTS (SELECT 1 FROM transaction_fact f WHERE f.account_key = a.account_key) "
            "ORDER BY a.region, a.district_name")