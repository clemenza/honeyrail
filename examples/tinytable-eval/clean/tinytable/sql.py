"""A tiny single-table SQL front end for tinytable.

Parses and executes a small subset of SQL (see ../SPEC.md's "SQL Surface"
section for the exact grammar) against the existing Table/Predicate/Query
engine in core.py - this module is purely a translation layer, not a second
implementation of the underlying semantics.

Deliberately out of scope: JOINs, subqueries, GROUP BY, multiple aggregates
or an aggregate mixed with plain columns in one SELECT, transactions that
span statements other than SAVEPOINT/ROLLBACK TO/RELEASE/COMMIT. All of
these raise SqlError with a clear message rather than silently doing
something unintended.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Optional

from . import core


class SqlError(core.TinyTableError):
    """Raised for a SQL syntax error or an unsupported/invalid statement."""


# ---------------------------------------------------------------------------
# Tokenizer
# ---------------------------------------------------------------------------

_TOKEN_SPEC = [
    ("WS", r"[ \t\r\n]+"),
    ("STRING", r"'(?:[^']|'')*'"),
    ("NUMBER", r"\d+\.\d+|\d+"),
    ("OP", r"<=|>=|!=|<>|[=<>(),.*]"),
    ("IDENT", r"[A-Za-z_][A-Za-z0-9_]*"),
]
_MASTER_RE = re.compile("|".join(f"(?P<{name}>{pattern})" for name, pattern in _TOKEN_SPEC))


@dataclass
class Token:
    kind: str
    value: Any
    pos: int


def tokenize(text: str) -> list[Token]:
    tokens = []
    pos = 0
    while pos < len(text):
        m = _MASTER_RE.match(text, pos)
        if not m:
            raise SqlError(f"unexpected character {text[pos]!r} at position {pos}")
        kind = m.lastgroup
        raw = m.group()
        start = pos
        pos = m.end()
        if kind == "WS":
            continue
        value: Any = raw
        if kind == "STRING":
            value = raw[1:-1].replace("''", "'")
        elif kind == "NUMBER":
            value = float(raw) if "." in raw else int(raw)
        tokens.append(Token(kind, value, start))
    tokens.append(Token("EOF", None, len(text)))
    return tokens


_KEYWORDS = {
    "CREATE", "TABLE", "INDEX", "UNIQUE", "ON", "INSERT", "INTO", "VALUES",
    "UPDATE", "SET", "DELETE", "FROM", "WHERE", "SELECT", "ORDER", "BY",
    "ASC", "DESC", "NULLS", "FIRST", "LAST", "LIMIT", "OFFSET", "AND", "OR",
    "NOT", "BETWEEN", "IN", "IS", "NULL", "SAVEPOINT", "ROLLBACK", "TO",
    "RELEASE", "COMMIT", "COUNT", "MIN", "MAX",
}


# ---------------------------------------------------------------------------
# AST
# ---------------------------------------------------------------------------


@dataclass
class CreateTable:
    table: str
    columns: list[str]


@dataclass
class CreateIndex:
    table: str
    column: str
    unique: bool


@dataclass
class Insert:
    table: str
    columns: Optional[list[str]]
    values: list[Any]


@dataclass
class Update:
    table: str
    assignments: list[tuple[str, Any]]
    where: Optional[Any]


@dataclass
class Delete:
    table: str
    where: Optional[Any]


@dataclass
class SelectItem:
    kind: str  # "star" | "column" | "count" | "min" | "max"
    column: Optional[str] = None  # None means "*" for count


@dataclass
class Select:
    table: str
    items: list[SelectItem]
    where: Optional[Any]
    order_by: Optional[tuple[str, bool, bool]]  # (column, desc, nulls_last)
    limit: Optional[int]
    offset: Optional[int]


@dataclass
class Savepoint:
    name: str


@dataclass
class RollbackTo:
    name: str


@dataclass
class Release:
    name: str


@dataclass
class Commit:
    pass


# Predicate AST (translated into core.Predicate by execute())
@dataclass
class Cmp:
    column: str
    op: str
    value: Any


@dataclass
class BetweenNode:
    column: str
    lo: Any
    hi: Any


@dataclass
class InNode:
    column: str
    values: list[Any]


@dataclass
class NullCheck:
    column: str
    negated: bool


@dataclass
class BoolOp:
    op: str  # "and" | "or" | "not"
    parts: list[Any] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------


class Parser:
    def __init__(self, tokens: list[Token]):
        self._tokens = tokens
        self._pos = 0

    def _peek(self) -> Token:
        return self._tokens[self._pos]

    def _advance(self) -> Token:
        tok = self._tokens[self._pos]
        self._pos += 1
        return tok

    def _at_keyword(self, word: str) -> bool:
        tok = self._peek()
        return tok.kind == "IDENT" and tok.value.upper() == word

    def _eat_keyword(self, word: str) -> Token:
        if not self._at_keyword(word):
            tok = self._peek()
            raise SqlError(f"expected keyword {word!r}, got {tok.kind} {tok.value!r} at position {tok.pos}")
        return self._advance()

    def _try_keyword(self, word: str) -> bool:
        if self._at_keyword(word):
            self._advance()
            return True
        return False

    def _eat_op(self, op: str) -> Token:
        tok = self._peek()
        if not (tok.kind == "OP" and tok.value == op):
            raise SqlError(f"expected {op!r}, got {tok.kind} {tok.value!r} at position {tok.pos}")
        return self._advance()

    def _try_op(self, op: str) -> bool:
        tok = self._peek()
        if tok.kind == "OP" and tok.value == op:
            self._advance()
            return True
        return False

    def _eat_ident(self) -> str:
        tok = self._peek()
        if tok.kind != "IDENT":
            raise SqlError(f"expected identifier, got {tok.kind} {tok.value!r} at position {tok.pos}")
        self._advance()
        return tok.value

    def _eat_value(self) -> Any:
        tok = self._peek()
        if self._at_keyword("NULL"):
            self._advance()
            return None
        if tok.kind in ("STRING", "NUMBER"):
            self._advance()
            return tok.value
        raise SqlError(f"expected a value, got {tok.kind} {tok.value!r} at position {tok.pos}")

    # -- top level ---------------------------------------------------------

    def parse_statement(self):
        if self._at_keyword("CREATE"):
            return self._parse_create()
        if self._at_keyword("INSERT"):
            return self._parse_insert()
        if self._at_keyword("UPDATE"):
            return self._parse_update()
        if self._at_keyword("DELETE"):
            return self._parse_delete()
        if self._at_keyword("SELECT"):
            return self._parse_select()
        if self._at_keyword("SAVEPOINT"):
            return self._parse_savepoint()
        if self._at_keyword("ROLLBACK"):
            return self._parse_rollback()
        if self._at_keyword("RELEASE"):
            return self._parse_release()
        if self._at_keyword("COMMIT"):
            self._advance()
            return Commit()
        tok = self._peek()
        raise SqlError(f"unrecognized statement starting at {tok.kind} {tok.value!r} (position {tok.pos})")

    def _parse_column_list(self) -> list[str]:
        self._eat_op("(")
        cols = [self._eat_ident()]
        while self._try_op(","):
            cols.append(self._eat_ident())
        self._eat_op(")")
        return cols

    def _parse_create(self):
        self._eat_keyword("CREATE")
        if self._try_keyword("UNIQUE"):
            self._eat_keyword("INDEX")
            index_name = self._eat_ident()
            self._eat_keyword("ON")
            table = self._eat_ident()
            self._eat_op("(")
            column = self._eat_ident()
            self._eat_op(")")
            return CreateIndex(table=table, column=column, unique=True)
        if self._try_keyword("INDEX"):
            index_name = self._eat_ident()
            self._eat_keyword("ON")
            table = self._eat_ident()
            self._eat_op("(")
            column = self._eat_ident()
            self._eat_op(")")
            return CreateIndex(table=table, column=column, unique=False)
        self._eat_keyword("TABLE")
        table = self._eat_ident()
        columns = self._parse_column_list()
        return CreateTable(table=table, columns=columns)

    def _parse_insert(self):
        self._eat_keyword("INSERT")
        self._eat_keyword("INTO")
        table = self._eat_ident()
        columns = None
        if self._peek().kind == "OP" and self._peek().value == "(":
            columns = self._parse_column_list()
        self._eat_keyword("VALUES")
        self._eat_op("(")
        values = [self._eat_value()]
        while self._try_op(","):
            values.append(self._eat_value())
        self._eat_op(")")
        return Insert(table=table, columns=columns, values=values)

    def _parse_update(self):
        self._eat_keyword("UPDATE")
        table = self._eat_ident()
        self._eat_keyword("SET")
        assignments = [self._parse_assignment()]
        while self._try_op(","):
            assignments.append(self._parse_assignment())
        where = self._parse_optional_where()
        return Update(table=table, assignments=assignments, where=where)

    def _parse_assignment(self):
        col = self._eat_ident()
        self._eat_op("=")
        value = self._eat_value()
        return (col, value)

    def _parse_delete(self):
        self._eat_keyword("DELETE")
        self._eat_keyword("FROM")
        table = self._eat_ident()
        where = self._parse_optional_where()
        return Delete(table=table, where=where)

    def _parse_select(self):
        self._eat_keyword("SELECT")
        items = self._parse_select_items()
        self._eat_keyword("FROM")
        table = self._eat_ident()
        where = self._parse_optional_where()
        order_by = None
        if self._try_keyword("ORDER"):
            self._eat_keyword("BY")
            col = self._eat_ident()
            desc = False
            if self._try_keyword("DESC"):
                desc = True
            else:
                self._try_keyword("ASC")
            nulls_last = True
            if self._try_keyword("NULLS"):
                if self._try_keyword("FIRST"):
                    nulls_last = False
                else:
                    self._eat_keyword("LAST")
                    nulls_last = True
            order_by = (col, desc, nulls_last)
        limit = None
        if self._try_keyword("LIMIT"):
            limit = self._eat_number()
        offset = None
        if self._try_keyword("OFFSET"):
            offset = self._eat_number()
        return Select(table=table, items=items, where=where, order_by=order_by, limit=limit, offset=offset)

    def _eat_number(self) -> int:
        tok = self._peek()
        if tok.kind != "NUMBER":
            raise SqlError(f"expected a number, got {tok.kind} {tok.value!r} at position {tok.pos}")
        self._advance()
        return int(tok.value)

    def _parse_select_items(self) -> list[SelectItem]:
        if self._try_op("*"):
            return [SelectItem(kind="star")]
        items = [self._parse_select_item()]
        while self._try_op(","):
            items.append(self._parse_select_item())
        return items

    def _parse_select_item(self) -> SelectItem:
        for keyword, kind in (("COUNT", "count"), ("MIN", "min"), ("MAX", "max")):
            if self._at_keyword(keyword):
                self._advance()
                self._eat_op("(")
                if kind == "count" and self._try_op("*"):
                    column = None
                else:
                    column = self._eat_ident()
                self._eat_op(")")
                return SelectItem(kind=kind, column=column)
        return SelectItem(kind="column", column=self._eat_ident())

    def _parse_optional_where(self):
        if self._try_keyword("WHERE"):
            return self._parse_or()
        return None

    def _parse_savepoint(self):
        self._eat_keyword("SAVEPOINT")
        return Savepoint(name=self._eat_ident())

    def _parse_rollback(self):
        self._eat_keyword("ROLLBACK")
        self._eat_keyword("TO")
        self._try_keyword("SAVEPOINT")
        return RollbackTo(name=self._eat_ident())

    def _parse_release(self):
        self._eat_keyword("RELEASE")
        self._try_keyword("SAVEPOINT")
        return Release(name=self._eat_ident())

    # -- condition grammar ---------------------------------------------------

    def _parse_or(self):
        parts = [self._parse_and()]
        while self._try_keyword("OR"):
            parts.append(self._parse_and())
        return parts[0] if len(parts) == 1 else BoolOp(op="or", parts=parts)

    def _parse_and(self):
        parts = [self._parse_not()]
        while self._try_keyword("AND"):
            parts.append(self._parse_not())
        return parts[0] if len(parts) == 1 else BoolOp(op="and", parts=parts)

    def _parse_not(self):
        if self._try_keyword("NOT"):
            return BoolOp(op="not", parts=[self._parse_not()])
        return self._parse_primary_cond()

    def _parse_primary_cond(self):
        if self._try_op("("):
            inner = self._parse_or()
            self._eat_op(")")
            return inner
        return self._parse_comparison()

    def _parse_comparison(self):
        column = self._eat_ident()
        if self._try_keyword("BETWEEN"):
            lo = self._eat_value()
            self._eat_keyword("AND")
            hi = self._eat_value()
            return BetweenNode(column=column, lo=lo, hi=hi)
        if self._try_keyword("IN"):
            self._eat_op("(")
            values = [self._eat_value()]
            while self._try_op(","):
                values.append(self._eat_value())
            self._eat_op(")")
            return InNode(column=column, values=values)
        if self._try_keyword("IS"):
            negated = self._try_keyword("NOT")
            self._eat_keyword("NULL")
            return NullCheck(column=column, negated=negated)
        tok = self._peek()
        if tok.kind == "OP" and tok.value in ("=", "!=", "<>", "<", "<=", ">", ">="):
            self._advance()
            op = {"=": "eq", "!=": "ne", "<>": "ne", "<": "lt", "<=": "le", ">": "gt", ">=": "ge"}[tok.value]
            value = self._eat_value()
            return Cmp(column=column, op=op, value=value)
        raise SqlError(f"expected a comparison operator after column {column!r}, got {tok.kind} {tok.value!r} at position {tok.pos}")


def parse(sql_text: str):
    """Parse exactly one SQL statement (an optional trailing ';' is allowed)."""
    text = sql_text.strip()
    if text.endswith(";"):
        text = text[:-1]
    tokens = tokenize(text)
    parser = Parser(tokens)
    stmt = parser.parse_statement()
    tok = parser._peek()
    if tok.kind != "EOF":
        raise SqlError(f"unexpected trailing input: {tok.kind} {tok.value!r} at position {tok.pos}")
    return stmt


# ---------------------------------------------------------------------------
# Predicate translation
# ---------------------------------------------------------------------------

_CMP_BUILDERS = {
    "eq": core.eq, "ne": core.ne, "lt": core.lt, "le": core.le, "gt": core.gt, "ge": core.ge,
}


def _build_predicate(node) -> core.Predicate:
    if isinstance(node, Cmp):
        return _CMP_BUILDERS[node.op](node.column, node.value)
    if isinstance(node, BetweenNode):
        return core.between(node.column, node.lo, node.hi)
    if isinstance(node, InNode):
        return core.in_(node.column, node.values)
    if isinstance(node, NullCheck):
        return core.not_null(node.column) if node.negated else core.is_null(node.column)
    if isinstance(node, BoolOp):
        if node.op == "not":
            return ~_build_predicate(node.parts[0])
        built = [_build_predicate(p) for p in node.parts]
        result = built[0]
        for part in built[1:]:
            result = (result | part) if node.op == "or" else (result & part)
        return result
    raise SqlError(f"unrecognized condition node: {node!r}")


# ---------------------------------------------------------------------------
# Execution
# ---------------------------------------------------------------------------


@dataclass
class QueryResult:
    columns: list[str]
    rows: list[tuple]


class Database:
    """A named collection of tables - the thing a SQL script actually talks
    to (SQL statements reference tables by name, unlike the bare
    core.Table() a caller constructs directly for the Python API).
    """

    def __init__(self):
        self._tables: dict[str, core.Table] = {}
        self._schemas: dict[str, list[str]] = {}

    def table(self, name: str) -> core.Table:
        if name not in self._tables:
            raise SqlError(f"no such table: {name}")
        return self._tables[name]

    def _for_each_table_with_savepoint(self, name: str, action) -> None:
        matching = [t for t in self._tables.values() if name in t._savepoints]
        if not matching:
            raise core.NoSuchSavepoint(f"no such savepoint: {name!r}")
        for table in matching:
            action(table)

    def execute(self, sql_text: str) -> Optional[QueryResult]:
        """Parse and execute exactly one SQL statement."""
        stmt = parse(sql_text)
        return self._execute_stmt(stmt)

    def _execute_stmt(self, stmt) -> Optional[QueryResult]:
        if isinstance(stmt, CreateTable):
            if stmt.table in self._tables:
                raise SqlError(f"table {stmt.table!r} already exists")
            self._tables[stmt.table] = core.Table(stmt.table)
            self._schemas[stmt.table] = list(stmt.columns)
            return None
        if isinstance(stmt, CreateIndex):
            table = self.table(stmt.table)
            if stmt.unique:
                table.unique(stmt.column)
            else:
                table.create_index(stmt.column)
            return None
        if isinstance(stmt, Insert):
            table = self.table(stmt.table)
            columns = stmt.columns if stmt.columns is not None else self._schemas.get(stmt.table)
            if columns is None:
                raise SqlError(f"INSERT INTO {stmt.table} needs an explicit column list (no CREATE TABLE schema on record)")
            if len(columns) != len(stmt.values):
                raise SqlError(f"column count {len(columns)} does not match value count {len(stmt.values)}")
            table.insert(dict(zip(columns, stmt.values)))
            return None
        if isinstance(stmt, Update):
            table = self.table(stmt.table)
            predicate = _build_predicate(stmt.where) if stmt.where is not None else _AllPredicate()
            changes = dict(stmt.assignments)
            table.update(predicate, changes)
            return None
        if isinstance(stmt, Delete):
            table = self.table(stmt.table)
            predicate = _build_predicate(stmt.where) if stmt.where is not None else _AllPredicate()
            table.delete(predicate)
            return None
        if isinstance(stmt, Select):
            return self._execute_select(stmt)
        if isinstance(stmt, Savepoint):
            # A database-wide savepoint: every table that exists right now
            # gets it. A table CREATE'd later is simply untouched by an
            # earlier name (there's nothing on it yet to roll back to).
            for table in self._tables.values():
                table.savepoint(stmt.name)
            return None
        if isinstance(stmt, RollbackTo):
            self._for_each_table_with_savepoint(stmt.name, lambda t: t.rollback_to(stmt.name))
            return None
        if isinstance(stmt, Release):
            self._for_each_table_with_savepoint(stmt.name, lambda t: t.commit(stmt.name))
            return None
        if isinstance(stmt, Commit):
            for table in self._tables.values():
                table.commit(None)
            return None
        raise SqlError(f"unrecognized statement: {stmt!r}")

    def _execute_select(self, stmt: Select) -> QueryResult:
        table = self.table(stmt.table)
        predicate = _build_predicate(stmt.where) if stmt.where is not None else None
        query = table.where(predicate) if predicate is not None else table.select()
        if stmt.order_by is not None:
            col, desc, nulls_last = stmt.order_by
            query = query.order_by(col, desc=desc, nulls_last=nulls_last)
        if stmt.limit is not None:
            query = query.limit(stmt.limit)
        if stmt.offset is not None:
            query = query.offset(stmt.offset)

        if any(item.kind != "column" and item.kind != "star" for item in stmt.items):
            if len(stmt.items) != 1:
                raise SqlError("an aggregate SELECT must have exactly one item (no mixing with plain columns)")
            item = stmt.items[0]
            if item.kind == "count":
                value = query.count(item.column if item.column is not None else "*")
            elif item.kind == "min":
                value = query.min(item.column)
            else:
                value = query.max(item.column)
            label = f"{item.kind}({item.column or '*'})"
            return QueryResult(columns=[label], rows=[(value,)])

        rows = query.all()
        if len(stmt.items) == 1 and stmt.items[0].kind == "star":
            columns = self._schemas.get(stmt.table) or (sorted({k for row in rows for k in row}) if rows else [])
        else:
            columns = [item.column for item in stmt.items]
        result_rows = [tuple(row.get(col) for col in columns) for row in rows]
        return QueryResult(columns=columns, rows=result_rows)


class _AllPredicate(core.Predicate):
    def matches(self, row: dict) -> bool:
        return True
