ALTER TABLE metadata_connections ADD COLUMN IF NOT EXISTS refresh_interval_minutes integer NOT NULL DEFAULT 0 CHECK(refresh_interval_minutes BETWEEN 0 AND 10080);
ALTER TABLE metadata_connections ADD COLUMN IF NOT EXISTS history_retention_days integer NOT NULL DEFAULT 0 CHECK(history_retention_days BETWEEN 0 AND 36500);
ALTER TABLE metadata_connections ADD COLUMN IF NOT EXISTS engine text NOT NULL DEFAULT 'postgres' CHECK(engine IN ('postgres','mssql'));
ALTER TABLE metadata_connections ALTER COLUMN password_encrypted DROP NOT NULL;
ALTER TABLE metadata_connections ADD COLUMN IF NOT EXISTS secret_ref text UNIQUE;
ALTER TABLE metadata_connections ADD COLUMN IF NOT EXISTS label text NOT NULL DEFAULT '';
ALTER TABLE metadata_connections ADD COLUMN IF NOT EXISTS keep_alive boolean NOT NULL DEFAULT true;
CREATE TABLE IF NOT EXISTS metadata_storage_version(version integer PRIMARY KEY CHECK(version=2));
INSERT INTO metadata_storage_version VALUES(2) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS metadata_refresh_jobs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),connection_id uuid NOT NULL REFERENCES metadata_connections ON DELETE CASCADE,
  trigger text NOT NULL,status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed')),
  started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,change_count integer NOT NULL DEFAULT 0,
  baseline boolean NOT NULL DEFAULT false,error text,UNIQUE(connection_id,id));
CREATE UNIQUE INDEX IF NOT EXISTS metadata_one_active_refresh ON metadata_refresh_jobs(connection_id) WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS metadata_snapshots(
  connection_id uuid PRIMARY KEY REFERENCES metadata_connections ON DELETE CASCADE,
  job_id uuid NOT NULL,captured_at timestamptz NOT NULL DEFAULT now(),
  database_name text NOT NULL,username text NOT NULL,server_version text NOT NULL,database_size bigint NOT NULL,
  schema_count integer NOT NULL,object_count integer NOT NULL,
  FOREIGN KEY(connection_id,job_id) REFERENCES metadata_refresh_jobs(connection_id,id));
CREATE TABLE IF NOT EXISTS metadata_schemas(
  connection_id uuid REFERENCES metadata_snapshots ON DELETE CASCADE,id bigint NOT NULL,name text NOT NULL,
  owner text,comment text,is_system boolean NOT NULL DEFAULT false,PRIMARY KEY(connection_id,id),UNIQUE(connection_id,name));
CREATE TABLE IF NOT EXISTS metadata_relations(
  connection_id uuid NOT NULL,id bigint NOT NULL,schema_id bigint NOT NULL,name text NOT NULL,kind text NOT NULL,relkind text NOT NULL,
  owner text,comment text,estimated_rows bigint,size bigint,definition text,PRIMARY KEY(connection_id,id),UNIQUE(connection_id,schema_id,name),
  FOREIGN KEY(connection_id,schema_id) REFERENCES metadata_schemas(connection_id,id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS metadata_inheritance(
  connection_id uuid NOT NULL,child_id bigint NOT NULL,parent_id bigint NOT NULL,ordinal integer NOT NULL CHECK(ordinal>0),
  PRIMARY KEY(connection_id,child_id,parent_id),UNIQUE(connection_id,child_id,ordinal),CHECK(child_id<>parent_id),
  FOREIGN KEY(connection_id,child_id) REFERENCES metadata_relations(connection_id,id) ON DELETE CASCADE,
  FOREIGN KEY(connection_id,parent_id) REFERENCES metadata_relations(connection_id,id) DEFERRABLE INITIALLY DEFERRED);
CREATE INDEX IF NOT EXISTS metadata_inheritance_parent ON metadata_inheritance(connection_id,parent_id);
CREATE TABLE IF NOT EXISTS metadata_types(
  connection_id uuid NOT NULL,id bigint NOT NULL,schema_id bigint NOT NULL,name text NOT NULL,formatted_type text NOT NULL,
  kind text NOT NULL,relation_kind text,source_relation_oid bigint,element_type_id bigint,base_type_id bigint,comment text,
  PRIMARY KEY(connection_id,id),UNIQUE(connection_id,schema_id,name),
  FOREIGN KEY(connection_id,schema_id) REFERENCES metadata_schemas(connection_id,id) ON DELETE CASCADE,
  FOREIGN KEY(connection_id,element_type_id) REFERENCES metadata_types(connection_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(connection_id,base_type_id) REFERENCES metadata_types(connection_id,id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE IF NOT EXISTS metadata_columns(
  connection_id uuid NOT NULL,table_id bigint NOT NULL,position integer NOT NULL CHECK(position>0),name text NOT NULL,
  type_id bigint NOT NULL,formatted_type text NOT NULL,nullable boolean NOT NULL,default_expression text,identity_kind text NOT NULL DEFAULT '',generated_kind text NOT NULL DEFAULT '',comment text,
  PRIMARY KEY(connection_id,table_id,position),UNIQUE(connection_id,table_id,name),
  FOREIGN KEY(connection_id,table_id) REFERENCES metadata_relations(connection_id,id) ON DELETE CASCADE,
  FOREIGN KEY(connection_id,type_id) REFERENCES metadata_types(connection_id,id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE IF NOT EXISTS metadata_type_attributes(
  connection_id uuid NOT NULL,owner_type_id bigint NOT NULL,position integer NOT NULL CHECK(position>0),name text NOT NULL,
  type_id bigint NOT NULL,formatted_type text NOT NULL,nullable boolean NOT NULL,default_expression text,
  identity_kind text NOT NULL DEFAULT '',generated_kind text NOT NULL DEFAULT '',comment text,
  PRIMARY KEY(connection_id,owner_type_id,position),UNIQUE(connection_id,owner_type_id,name),
  FOREIGN KEY(connection_id,owner_type_id) REFERENCES metadata_types(connection_id,id) ON DELETE CASCADE,
  FOREIGN KEY(connection_id,type_id) REFERENCES metadata_types(connection_id,id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE IF NOT EXISTS metadata_constraints(
  connection_id uuid NOT NULL,id bigint NOT NULL,table_id bigint NOT NULL,name text NOT NULL,type text NOT NULL,definition text NOT NULL,
  referenced_table_id bigint,on_delete text,on_update text,condition text,validated boolean NOT NULL,"deferrable" boolean NOT NULL,initially_deferred boolean NOT NULL,comment text,
  PRIMARY KEY(connection_id,id),UNIQUE(connection_id,table_id,name),UNIQUE(connection_id,id,table_id),UNIQUE(connection_id,id,referenced_table_id),
  FOREIGN KEY(connection_id,table_id) REFERENCES metadata_relations(connection_id,id) ON DELETE CASCADE,
  FOREIGN KEY(connection_id,referenced_table_id) REFERENCES metadata_relations(connection_id,id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE IF NOT EXISTS metadata_constraint_columns(
  connection_id uuid NOT NULL,constraint_id bigint NOT NULL,table_id bigint NOT NULL,ordinal integer NOT NULL CHECK(ordinal>0),
  column_position integer NOT NULL,referenced_table_id bigint,referenced_column_position integer,
  PRIMARY KEY(connection_id,constraint_id,ordinal),CHECK((referenced_table_id IS NULL)=(referenced_column_position IS NULL)),
  FOREIGN KEY(connection_id,constraint_id,table_id) REFERENCES metadata_constraints(connection_id,id,table_id) ON DELETE CASCADE,
  FOREIGN KEY(connection_id,constraint_id,referenced_table_id) REFERENCES metadata_constraints(connection_id,id,referenced_table_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(connection_id,table_id,column_position) REFERENCES metadata_columns(connection_id,table_id,position) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(connection_id,referenced_table_id,referenced_column_position) REFERENCES metadata_columns(connection_id,table_id,position) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE IF NOT EXISTS metadata_indexes(
  connection_id uuid NOT NULL,id bigint NOT NULL,table_id bigint NOT NULL,name text NOT NULL,method text NOT NULL,
  is_unique boolean NOT NULL,is_primary boolean NOT NULL,valid boolean NOT NULL,ready boolean NOT NULL,condition text,definition text NOT NULL,constraint_id bigint,
  PRIMARY KEY(connection_id,id),UNIQUE(connection_id,table_id,name),
  FOREIGN KEY(connection_id,table_id) REFERENCES metadata_relations(connection_id,id) ON DELETE CASCADE,
  FOREIGN KEY(connection_id,constraint_id,table_id) REFERENCES metadata_constraints(connection_id,id,table_id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE IF NOT EXISTS metadata_index_attributes(
  connection_id uuid NOT NULL,index_id bigint NOT NULL,ordinal integer NOT NULL CHECK(ordinal>0),expression text NOT NULL,included boolean NOT NULL,
  PRIMARY KEY(connection_id,index_id,ordinal),
  FOREIGN KEY(connection_id,index_id) REFERENCES metadata_indexes(connection_id,id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS metadata_partitions(
  connection_id uuid NOT NULL,table_id bigint NOT NULL,method text CHECK(method IN ('RANGE','LIST','HASH')),partition_key text,bounds text,
  PRIMARY KEY(connection_id,table_id),FOREIGN KEY(connection_id,table_id) REFERENCES metadata_relations(connection_id,id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS metadata_routines(
  connection_id uuid NOT NULL,id bigint NOT NULL,schema_id bigint NOT NULL,name text NOT NULL,kind text NOT NULL,
  arguments text NOT NULL,result text,language text NOT NULL,definition text NOT NULL,PRIMARY KEY(connection_id,id),
  FOREIGN KEY(connection_id,schema_id) REFERENCES metadata_schemas(connection_id,id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS metadata_routines_schema ON metadata_routines(connection_id,schema_id,name);
-- Platform key definitions outlive source-column removal so invalid keys can be repaired.
CREATE TABLE IF NOT EXISTS metadata_logical_keys(
  connection_id uuid REFERENCES metadata_connections ON DELETE CASCADE,table_id bigint NOT NULL,name text NOT NULL,PRIMARY KEY(connection_id,table_id));
CREATE TABLE IF NOT EXISTS metadata_logical_key_columns(
  connection_id uuid NOT NULL,table_id bigint NOT NULL,ordinal integer NOT NULL CHECK(ordinal>0),column_position integer NOT NULL CHECK(column_position>0),
  PRIMARY KEY(connection_id,table_id,ordinal),UNIQUE(connection_id,table_id,column_position),
  FOREIGN KEY(connection_id,table_id) REFERENCES metadata_logical_keys(connection_id,table_id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS metadata_history_edges(
  connection_id uuid REFERENCES metadata_connections ON DELETE CASCADE,parent_id text NOT NULL,child_id text NOT NULL,PRIMARY KEY(connection_id,parent_id,child_id));
CREATE TABLE IF NOT EXISTS metadata_changes(
  id bigserial PRIMARY KEY,job_id uuid NOT NULL,connection_id uuid NOT NULL REFERENCES metadata_connections ON DELETE CASCADE,
  entity_type text NOT NULL,entity_id text NOT NULL,entity_name text NOT NULL,table_ids text[] NOT NULL,operation text NOT NULL,field text NOT NULL,previous_value jsonb,new_value jsonb,
  FOREIGN KEY(connection_id,job_id) REFERENCES metadata_refresh_jobs(connection_id,id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS metadata_changes_connection ON metadata_changes(connection_id,id DESC);
CREATE INDEX IF NOT EXISTS metadata_changes_job ON metadata_changes(job_id,id);
CREATE INDEX IF NOT EXISTS metadata_changes_tables ON metadata_changes USING gin(table_ids);
ALTER TABLE metadata_columns ADD COLUMN IF NOT EXISTS identity_seed text;
ALTER TABLE metadata_columns ADD COLUMN IF NOT EXISTS identity_increment text;
ALTER TABLE metadata_type_attributes ADD COLUMN IF NOT EXISTS identity_seed text;
ALTER TABLE metadata_type_attributes ADD COLUMN IF NOT EXISTS identity_increment text;
ALTER TABLE metadata_constraints ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
ALTER TABLE metadata_indexes ADD COLUMN IF NOT EXISTS nulls_not_distinct boolean;
CREATE TABLE IF NOT EXISTS metadata_sqlserver_partitions(
  connection_id uuid NOT NULL,table_id bigint NOT NULL,partition_number integer NOT NULL CHECK(partition_number>0),partition_id bigint NOT NULL,
  function_name text NOT NULL,scheme text NOT NULL,boundary_on_right boolean NOT NULL,lower_bound text,upper_bound text,filegroup text,row_count bigint NOT NULL,
  PRIMARY KEY(connection_id,table_id,partition_number),
  FOREIGN KEY(connection_id,table_id) REFERENCES metadata_relations(connection_id,id) ON DELETE CASCADE);
