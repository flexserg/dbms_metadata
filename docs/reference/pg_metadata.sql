
-- бд
SELECT
    current_database() AS name,
    oid AS source_id,
    pg_get_userbyid(datdba) AS owner,
    current_setting('server_version') AS version,
    pg_database_size(current_database()) AS size,
    (
        SELECT
            count(*)
        FROM
            pg_namespace n
        WHERE
            n.nspname NOT IN ('pg_catalog', 'information_schema')
                AND n.nspname !~ '^pg_toast'
    ) AS schemas_count,
    (
        SELECT
            count(*)
        FROM
            pg_class c
        JOIN pg_namespace n
            ON n.oid = c.relnamespace
        WHERE n.nspname <> 'information_schema'
            AND n.nspname !~ '^pg_'
            AND c.relkind IN ('r', 'p')
            AND c.relpersistence = 'p'
    ) AS objects_count
FROM
    pg_database
WHERE
    datname = current_database();

--схемы
SELECT
    n.nspname AS name,
    n.oid AS source_id,
    pg_get_userbyid(n.nspowner) AS owner,
    obj_description(n.oid, 'pg_namespace') AS comment
FROM pg_namespace n
WHERE n.nspname <> 'information_schema'
    AND n.nspname !~ '^pg_'
GROUP BY n.oid
ORDER BY n.nspname;

--таблицы
SELECT
    c.relname AS name,
    c.oid AS source_id,
    pg_get_userbyid(c.relowner) AS owner,
    obj_description(c.oid, 'pg_class') AS COMMENT,
    c.relkind AS relkind,
    pg_total_relation_size(c.oid) AS size,
     (
        SELECT
            inhparent
        FROM pg_inherits
        WHERE inhrelid=c.oid
        ORDER BY inhseqno
        LIMIT 1
    ) AS parent_id,
    ARRAY(
        SELECT
            inhparent
        FROM pg_inherits
        WHERE inhrelid=c.oid
        ORDER BY inhseqno
    ) AS parent_ids
FROM pg_class c
JOIN pg_namespace n
    ON n.oid = c.relnamespace
WHERE n.nspname <> 'information_schema'
  AND n.nspname !~ '^pg_'
  AND c.relkind IN ('r', 'p')
  AND c.relpersistence = 'p'
ORDER BY c.relname;

--атрибуты
SELECT
    a.attrelid AS table_source_id,
    a.attnum AS position,
    a.attrelid::text || ':' || a.attnum::text AS source_id,
    a.attname AS name,
    a.atttypid AS type_id,
    format_type(a.atttypid, a.atttypmod) AS type,
    NOT a.attnotnull AS nullable,
    pg_get_expr(d.adbin, d.adrelid) AS default,
    col_description(a.attrelid, a.attnum) AS comment,
    a.attidentity AS identity,
    a.attgenerated AS generated
FROM pg_attribute a
LEFT JOIN pg_attrdef d
   ON d.adrelid = a.attrelid
   AND d.adnum = a.attnum
WHERE a.attrelid IN (
    SELECT
        c.oid AS id
    FROM pg_class c
    JOIN pg_namespace n
        ON n.oid = c.relnamespace
    WHERE n.nspname <> 'information_schema'
      AND n.nspname !~ '^pg_'
      AND c.relkind IN ('r', 'p')
      AND c.relpersistence = 'p'
    )
  AND a.attnum > 0
  AND NOT a.attisdropped
ORDER BY a.attrelid, a.attnum;


--ограничения
SELECT
    k.conrelid AS table_source_id,
    k.oid AS source_id,
    k.conname AS name,
    k.contype AS type,
    pg_get_constraintdef(k.oid, true) AS definition,
    ARRAY(
        SELECT k.conrelid::text || ':' || u.num::text
        FROM unnest(k.conkey)
             WITH ORDINALITY u(num, ord)
        ORDER BY u.ord
    ) AS attributes,
    CASE WHEN k.confrelid <> 0
         THEN k.confrelid
    END AS referenced_table_id,
    CASE WHEN k.confrelid <> 0 THEN (
        SELECT quote_ident(n.nspname)
               || '.' || quote_ident(c.relname)
        FROM pg_class c
        JOIN pg_namespace n
          ON n.oid = c.relnamespace
        WHERE c.oid = k.confrelid
    ) END AS referenced_table,
    ARRAY(
        SELECT k.confrelid::text || ':' || u.num::text
        FROM unnest(k.confkey)
             WITH ORDINALITY u(num, ord)
        ORDER BY u.ord
    ) AS referenced_attributes,
    CASE k.confdeltype
        WHEN 'a' THEN 'NO ACTION'
        WHEN 'r' THEN 'RESTRICT'
        WHEN 'c' THEN 'CASCADE'
        WHEN 'n' THEN 'SET NULL'
        WHEN 'd' THEN 'SET DEFAULT'
    END AS on_delete,
    CASE k.confupdtype
        WHEN 'a' THEN 'NO ACTION'
        WHEN 'r' THEN 'RESTRICT'
        WHEN 'c' THEN 'CASCADE'
        WHEN 'n' THEN 'SET NULL'
        WHEN 'd' THEN 'SET DEFAULT'
    END AS on_update,
    pg_get_expr(k.conbin, k.conrelid, true) AS condition,
    k.convalidated AS validated,
    k.condeferrable AS deferrable,
    k.condeferred AS deferred,
    obj_description(k.oid, 'pg_constraint') AS comment
FROM pg_constraint k
WHERE k.conrelid IN (
    SELECT
        c.oid AS id
    FROM pg_class c
    JOIN pg_namespace n
        ON n.oid = c.relnamespace
    WHERE n.nspname <> 'information_schema'
      AND n.nspname !~ '^pg_'
      AND c.relkind IN ('r', 'p')
      AND c.relpersistence = 'p'
    )
ORDER BY k.conrelid, k.conname;


--индексы
SELECT
    i.indrelid AS table_id,
    c.oid AS id,
    c.relname AS name,
    am.amname AS type,

    i.indisunique AS unique,
    i.indisprimary AS primary,
    i.indisvalid AS valid,
    i.indisready AS ready,
    i.indnullsnotdistinct AS nullsnotdistinct,

    ARRAY(
        SELECT
            ii.indrelid::text || ':' || ii.indkey[s - 1]::text
        FROM pg_catalog.pg_index ii
        CROSS JOIN LATERAL generate_series(1, i.indnkeyatts) AS s
        WHERE i.indexrelid = ii.indexrelid
    ) AS attributes,

     ARRAY(
        SELECT
            ii.indrelid::text || ':' || ii.indkey[s - 1]::text
        FROM pg_catalog.pg_index ii
        CROSS JOIN LATERAL generate_series(i.indnkeyatts + 1, i.indnatts) AS s
        WHERE i.indexrelid = ii.indexrelid
    ) AS included_attributes,

    pg_get_expr(
        i.indpred, i.indrelid, true
    ) AS condition,

    k.oid AS constraint_source_id

FROM pg_index i
JOIN pg_class c
    ON c.oid = i.indexrelid
JOIN pg_am am
    ON am.oid = c.relam
LEFT JOIN pg_constraint k
    ON k.conindid = i.indexrelid
   AND k.contype IN ('p', 'u', 'x')
WHERE i.indrelid IN (
    SELECT
        c.oid AS id
    FROM pg_class c
    JOIN pg_namespace n
        ON n.oid = c.relnamespace
    WHERE n.nspname <> 'information_schema'
      AND n.nspname !~ '^pg_'
      AND c.relkind IN ('r', 'p')
      AND c.relpersistence = 'p'
    )
ORDER BY i.indrelid, c.relname;

--партиции
WITH RECURSIVE tree AS (
    -- 1. Корневые секционированные таблицы
    SELECT
        c.oid,
        NULL::oid AS parent_id,
        0 AS level
    FROM pg_class c
    JOIN pg_namespace n
        ON n.oid = c.relnamespace
    WHERE n.nspname <> 'information_schema'
      AND n.nspname !~ '^pg_'
      AND c.relkind = 'p'
      AND c.relpersistence = 'p'
      AND NOT c.relispartition
    UNION ALL
    -- 2. Все дочерние секции
    SELECT
        child.oid,
        i.inhparent AS parent_id,
        t.level + 1 AS level
    FROM tree t
    JOIN pg_inherits i
        ON i.inhparent = t.oid
    JOIN pg_class child
        ON child.oid = i.inhrelid
    WHERE child.relispartition = true
        AND child.relkind IN ('r', 'p')
)
SELECT
    t.oid::text AS source_id,
    t.parent_id::text AS parent_source_id,
    t.level,
    CASE pt.partstrat
        WHEN 'r' THEN 'RANGE'
        WHEN 'l' THEN 'LIST'
        WHEN 'h' THEN 'HASH'
    END AS method,
    pg_get_partkeydef(c.oid) AS partition_key,
    pg_get_expr(
        c.relpartbound,
        c.oid,
        true
    ) AS bounds
FROM tree t
JOIN pg_class c
    ON c.oid = t.oid
LEFT JOIN pg_partitioned_table pt
    ON pt.partrelid = c.oid
ORDER BY
    t.level,
    c.relname;
