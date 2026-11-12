import sql from "mssql";
import { randomUUID } from "node:crypto";
export async function mssqlFixture() {
  const name = "Atlas_" + randomUUID().replaceAll("-", "");
  const login = "reader_" + randomUUID().replaceAll("-", "");
  const config = {
    server: process.env.TEST_MSSQL_HOST || "127.0.0.1",
    port: Number(process.env.TEST_MSSQL_PORT || 51433),
    user: process.env.TEST_MSSQL_USER || "sa",
    password: process.env.TEST_MSSQL_PASSWORD || "Metadata_Test_2026!",
    database: "master",
    options: { encrypt: true, trustServerCertificate: true },
    requestTimeout: 30000,
  };
  const admin = new sql.ConnectionPool(config);
  await admin.connect();
  let db;
  const cleanup = async () => {
    if (db) await db.close();
    await admin
      .request()
      .batch(
        `ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;DROP DATABASE [${name}];IF EXISTS(SELECT 1 FROM sys.server_principals WHERE name='${login}') DROP LOGIN [${login}];`,
      );
    await admin.close();
  };
  try {
    await admin
      .request()
      .batch(
        `CREATE DATABASE [${name}];CREATE LOGIN [${login}] WITH PASSWORD='Metadata_Reader_2026!',CHECK_POLICY=OFF;`,
      );
    db = new sql.ConnectionPool({ ...config, database: name });
    await db.connect();
    await db.request().batch(`CREATE SCHEMA app;`);
    await db.request().batch("CREATE TYPE app.Code FROM nvarchar(20) NOT NULL");
    await db
      .request()
      .batch("CREATE TYPE app.ItemList AS TABLE(id int,label nvarchar(30))");
    await db.request().batch(`
      CREATE TABLE app.Parent(a int NOT NULL,b int NOT NULL,CONSTRAINT PK_Parent PRIMARY KEY(a,b));
      CREATE TABLE app.Items(id bigint IDENTITY(10,5) NOT NULL CONSTRAINT PK_Items PRIMARY KEY,parent_a int,parent_b int,
        code app.Code CONSTRAINT DF_Code DEFAULT N'C1',price decimal(38,5),label nvarchar(50) CONSTRAINT DF_Label DEFAULT N'start',
        upper_label AS UPPER(label) PERSISTED,CONSTRAINT FK_Items_Parent FOREIGN KEY(parent_a,parent_b) REFERENCES app.Parent(a,b) ON DELETE CASCADE,
        CONSTRAINT UQ_Code UNIQUE(code),CONSTRAINT CK_Price CHECK(price>=0));
      CREATE INDEX IX_Label ON app.Items(label DESC) INCLUDE(price) WHERE label IS NOT NULL;
      ALTER TABLE app.Items NOCHECK CONSTRAINT CK_Price;
      EXEC sys.sp_addextendedproperty @name=N'MS_Description',@value=N'Items table',@level0type=N'SCHEMA',@level0name=N'app',@level1type=N'TABLE',@level1name=N'Items';
      EXEC sys.sp_addextendedproperty @name=N'MS_Description',@value=N'Item label',@level0type=N'SCHEMA',@level0name=N'app',@level1type=N'TABLE',@level1name=N'Items',@level2type=N'COLUMN',@level2name=N'label';
      INSERT app.Parent VALUES(1,2);INSERT app.Items(parent_a,parent_b,price,label) VALUES(1,2,123456789012345678901234567890.12345,N'Preview sample');
      CREATE USER [${login}] FOR LOGIN [${login}];GRANT CONNECT TO [${login}];GRANT VIEW DEFINITION TO [${login}];GRANT SELECT ON sys.sql_expression_dependencies TO [${login}];GRANT SELECT ON SCHEMA::app TO [${login}];`);
    await db
      .request()
      .batch(
        "CREATE PARTITION FUNCTION RangeFn(int) AS RANGE RIGHT FOR VALUES(100,200)",
      );
    await db
      .request()
      .batch(
        "CREATE PARTITION SCHEME RangeScheme AS PARTITION RangeFn ALL TO([PRIMARY])",
      );
    await db.request()
      .batch(`CREATE TABLE app.Events(id int NOT NULL,bucket int NOT NULL,note nvarchar(20)) ON RangeScheme(bucket);
      CREATE CLUSTERED INDEX IX_Events ON app.Events(bucket,id) ON RangeScheme(bucket);
      CREATE NONCLUSTERED COLUMNSTORE INDEX IX_Columnstore ON app.Events(id,bucket);
      INSERT app.Events VALUES(1,50,N'early'),(2,150,N'middle'),(3,250,N'late');`);
    await db
      .request()
      .batch(
        "CREATE VIEW app.ItemsView AS SELECT id,label,price FROM app.Items",
      );
    await db
      .request()
      .batch(
        "CREATE FUNCTION app.DoubleIt(@value int) RETURNS int AS BEGIN RETURN @value*2; END",
      );
    await db
      .request()
      .batch(
        "CREATE PROCEDURE app.ListItems @prefix nvarchar(50) AS SELECT id,label FROM app.Items WHERE label LIKE @prefix",
      );
    return {
      db,
      name,
      cleanup,
      connection: {
        name: "SQL Server fixture",
        engine: "mssql",
        host: config.server,
        port: config.port,
        database: name,
        username: login,
        password: "Metadata_Reader_2026!",
        sslMode: "trust-server-certificate",
        driverProperties: { appName: "Atlas SQL fixture", useUTC: false },
      },
    };
  } catch (e) {
    await cleanup().catch(() => {});
    throw e;
  }
}
