/**
 * generate_dump.js  (fixed version)
 * ------------------------------------------------------------------
 * Writes ./dump.sql: INSERT statements that APPEND synthetic data to an
 * existing Sakila database (staff, store, customer, rental, payment).
 *
 * Run:
 *   npm install @faker-js/faker mysql2
 *   node generate_dump.js
 *
 * The script connects to your database only to READ things (current max
 * IDs, real address/inventory IDs, column types). It never writes to it.
 *
 * WHAT WAS FIXED IN THIS VERSION
 *  1. ID columns too small. store_id / staff_id / manager_staff_id are
 *     TINYINT UNSIGNED (max 255) and payment_id is SMALLINT UNSIGNED
 *     (max 65,535) in Sakila. The dump now starts with ALTER TABLE
 *     statements that widen only the columns that are too small (the
 *     six foreign keys on them are dropped and re-added around the ALTERs).
 *  2. Emails longer than 50 characters (email is VARCHAR(50)) made whole
 *     1,000-row INSERTs fail. Emails are now built to always fit.
 *  3. Sakila has BEFORE INSERT triggers on customer, rental and payment
 *     that overwrite create_date, rental_date and payment_date with NOW().
 *     The dump drops them before loading and re-creates them afterwards.
 *  4. Rentals now always happen AFTER the customer signed up.
 *  5. New customers are only assigned to the NEW stores (ids 3 to 1002),
 *     and every store gets at least one customer.
 *  6. rental.staff_id and payment.staff_id now point to the manager of the
 *     customer's home store, so rentals and payments trace back to a new store.
 *  7. Output is written with backpressure (waits for the file stream to
 *     drain), so memory stays flat no matter how many rows you generate.
 * ------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const { once } = require("events");
const mysql = require("mysql2/promise");
const { faker } = require("@faker-js/faker");

// ============================================================
// DATABASE CONNECTION (read only)
// Type your password below, or set the DB_PASSWORD environment variable.
// Do not share this file with your real password inside it.
// ============================================================
const DB_CONFIG = {
  host: "127.0.0.1",
  port: 3306,
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "martina 555",
  database: "sakila",
};

// ============================================================
// SETTINGS
// ============================================================
const CONFIG = {
  outFile: path.join(__dirname, "dump.sql"),
  batchSize: 1000, // rows per INSERT statement

  numStores: 1000,
  numCustomers: 20000,
  numTransactions: 100000, // one rental and one payment per transaction

  // Skew settings
  flagshipStorePct: 0.05, // 5% of stores are "flagships"
  flagshipStoreShare: 0.8, // ...and get about 80% of the customers
  powerUserPct: 0.05, // 5% of customers are "power users"
  powerUserShare: 0.75, // ...and make about 75% of the rentals
  weekendBiasProb: 0.65, // chance a rental date is pulled onto a weekend

  // Date ranges. Customers sign up before the rentals end, so everyone has time to rent.
  rentalDateStart: new Date("2023-01-01T00:00:00Z"),
  rentalDateEnd: new Date("2025-12-31T23:59:59Z"),
  customerCreateStart: new Date("2022-01-01T00:00:00Z"),
  customerCreateEnd: new Date("2025-11-30T23:59:59Z"),
  staffHireStart: new Date("2022-01-01T00:00:00Z"),
  staffHireEnd: new Date("2025-12-31T23:59:59Z"),

  // Payment model: daily rate times days kept
  dailyRateMin: 0.99,
  dailyRateMax: 4.99,
};

// The three triggers that ship with Sakila (they overwrite our dates with NOW()).
const DATE_TRIGGERS = [
  { name: "customer_create_date", table: "customer", body: "SET NEW.create_date = NOW()" },
  { name: "payment_date", table: "payment", body: "SET NEW.payment_date = NOW()" },
  { name: "rental_date", table: "rental", body: "SET NEW.rental_date = NOW()" },
];

// ID columns that must be able to hold our new, bigger numbers, grouped by table.
const WIDEN_COLUMNS = [
  { table: "staff", columns: ["staff_id", "store_id"] },
  { table: "store", columns: ["store_id", "manager_staff_id"] },
  { table: "customer", columns: ["store_id"] },
  { table: "inventory", columns: ["store_id"] },
  { table: "rental", columns: ["staff_id"] },
  { table: "payment", columns: ["staff_id", "payment_id"] },
];

// MySQL refuses to change the type of a column that is part of a foreign key
// (error 3780), even with FOREIGN_KEY_CHECKS=0. So the dump drops these six
// foreign keys, widens the columns, and adds the same keys back (same rules as stock Sakila).
const STANDARD_FKS = [
  { name: "fk_store_staff", table: "store", column: "manager_staff_id", refTable: "staff", refColumn: "staff_id" },
  { name: "fk_staff_store", table: "staff", column: "store_id", refTable: "store", refColumn: "store_id" },
  { name: "fk_customer_store", table: "customer", column: "store_id", refTable: "store", refColumn: "store_id" },
  { name: "fk_inventory_store", table: "inventory", column: "store_id", refTable: "store", refColumn: "store_id" },
  { name: "fk_rental_staff", table: "rental", column: "staff_id", refTable: "staff", refColumn: "staff_id" },
  { name: "fk_payment_staff", table: "payment", column: "staff_id", refTable: "staff", refColumn: "staff_id" },
];

// Largest value each integer type can hold
const TYPE_MAX = {
  "tinyint unsigned": 255,
  "smallint unsigned": 65535,
  "mediumint unsigned": 16777215,
  "int unsigned": 4294967295,
};

const DAY_MS = 24 * 60 * 60 * 1000;

// ============================================================
// SMALL HELPERS
// ============================================================

/** Pick a random element from an array of real, existing IDs. */
function pickFrom(idArray) {
  return idArray[Math.floor(Math.random() * idArray.length)];
}

/** Random whole number between min and max, both included. */
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Random date between two Date objects. */
function randomDate(start, end) {
  return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
}

/** Escape single quotes so names like O'Brien do not break the SQL. */
function sqlEscape(str) {
  return String(str).replace(/'/g, "''");
}

/** Turn a Date into 'YYYY-MM-DD HH:MM:SS' (UTC). */
function fmtDateTime(d) {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Builds an email that is guaranteed to fit in VARCHAR(50).
 * It keeps only letters (so O'Brien and hyphens are removed), and cuts the
 * name part if needed. The id suffix is always kept, so emails stay unique.
 */
function makeEmail(firstName, lastName, id, domain) {
  const letters = (s) => s.toLowerCase().replace(/[^a-z]/g, "");
  const ending = `.${id}@${domain}`;
  const room = 50 - ending.length; // characters left for the name part
  return `${letters(firstName)}.${letters(lastName)}`.slice(0, room) + ending;
}

/**
 * Builds a picker where a small "hot" slice of items (hotPct) gets most of
 * the weight (hotShare). Which items are hot is chosen at random.
 * pick() returns a 0-based index.
 */
function buildSkewedPicker(n, hotPct, hotShare) {
  const hotCount = Math.max(1, Math.floor(n * hotPct));
  const coldCount = n - hotCount;
  const hotWeightEach = hotShare / hotCount;
  const coldWeightEach = coldCount > 0 ? (1 - hotShare) / coldCount : 0;

  // Shuffle the order so the hot items are not always the first ones.
  const indices = new Uint32Array(n);
  for (let i = 0; i < n; i++) indices[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = indices[i];
    indices[i] = indices[j];
    indices[j] = tmp;
  }

  // Running totals of the weights, used for a fast lookup
  const cumulative = new Float64Array(n);
  let running = 0;
  for (let i = 0; i < n; i++) {
    running += i < hotCount ? hotWeightEach : coldWeightEach;
    cumulative[i] = running;
  }
  const total = cumulative[n - 1];

  function pick() {
    const r = Math.random() * total;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cumulative[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    return indices[lo];
  }

  return { pick };
}

/**
 * A random date that leans toward weekends. With probability weekendProb,
 * a Mon-Fri date is moved to the nearest Saturday or Sunday.
 */
function weekendSkewedDate(start, end, weekendProb) {
  let d = randomDate(start, end);
  if (Math.random() < weekendProb) {
    const day = d.getUTCDay(); // 0 = Sunday ... 6 = Saturday
    let shift = 0;
    if (day >= 1 && day <= 3) shift = -day; // Mon-Wed go back to Sunday
    else if (day >= 4 && day <= 5) shift = 6 - day; // Thu-Fri go forward to Saturday
    if (shift !== 0) {
      d = new Date(d.getTime() + shift * DAY_MS);
      if (d < start) d = new Date(start.getTime() + DAY_MS);
      if (d > end) d = new Date(end.getTime() - DAY_MS);
    }
  }
  return d;
}

/** Share (in %) of all rentals made by the busiest `fraction` of the items. */
function topShare(counts, fraction, totalRentals) {
  const sorted = Array.from(counts).sort((a, b) => b - a);
  const take = Math.ceil(sorted.length * fraction);
  let sum = 0;
  for (let i = 0; i < take; i++) sum += sorted[i];
  return ((100 * sum) / totalRentals).toFixed(1);
}

// ============================================================
// CHUNKED WRITER
// Collects rows and writes them as multi-row INSERT statements.
// Waits for the file stream to drain, so memory never piles up.
// ============================================================
class BatchInsertWriter {
  constructor(stream, table, columns, batchSize) {
    this.stream = stream;
    this.table = table;
    this.columns = columns;
    this.batchSize = batchSize;
    this.buffer = [];
  }

  async addRow(values) {
    this.buffer.push(`(${values.join(",")})`);
    if (this.buffer.length >= this.batchSize) await this.flush();
  }

  async flush() {
    if (this.buffer.length === 0) return;
    const sql = `INSERT INTO \`${this.table}\` (${this.columns.join(",")}) VALUES\n${this.buffer.join(",\n")};\n\n`;
    this.buffer = [];
    // write() returns false when the stream's buffer is full: wait until it empties.
    if (!this.stream.write(sql)) await once(this.stream, "drain");
  }
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  // ---------------------------------------------------------
  // 0. Read the real current state of the database
  // ---------------------------------------------------------
  console.log(`Connecting to ${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database} (read only)...`);
  const conn = await mysql.createConnection(DB_CONFIG);

  const [[ids]] = await conn.query(`
    SELECT
      COALESCE((SELECT MAX(store_id)    FROM store),    0) AS maxStoreId,
      COALESCE((SELECT MAX(staff_id)    FROM staff),    0) AS maxStaffId,
      COALESCE((SELECT MAX(customer_id) FROM customer), 0) AS maxCustomerId,
      COALESCE((SELECT MAX(rental_id)   FROM rental),   0) AS maxRentalId,
      COALESCE((SELECT MAX(payment_id)  FROM payment),  0) AS maxPaymentId
  `);
  const [addressRows] = await conn.query("SELECT address_id FROM address ORDER BY address_id");
  const [inventoryRows] = await conn.query("SELECT inventory_id FROM inventory ORDER BY inventory_id");
  const [columnRows] = await conn.query(
    `SELECT TABLE_NAME AS tbl, COLUMN_NAME AS col, COLUMN_TYPE AS type, EXTRA AS extra
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME IN ('store','staff','customer','inventory','rental','payment')`,
    [DB_CONFIG.database]
  );
  // The foreign keys that touch the columns we are about to widen (we need their real names)
  const [fkRows] = await conn.query(
    `SELECT TABLE_NAME AS tbl, COLUMN_NAME AS col, CONSTRAINT_NAME AS name
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
        AND TABLE_NAME IN ('store','staff','customer','inventory','rental','payment')`,
    [DB_CONFIG.database]
  );
  await conn.end();

  const existingAddressIds = addressRows.map((r) => Number(r.address_id));
  const existingInventoryIds = inventoryRows.map((r) => Number(r.inventory_id));
  if (existingAddressIds.length === 0) throw new Error("No rows in `address`. Check DB_CONFIG.database.");
  if (existingInventoryIds.length === 0) throw new Error("No rows in `inventory`. Check DB_CONFIG.database.");

  // Number(...) so that "2" + 1 is 3 and not "21"
  const startStoreId = Number(ids.maxStoreId) + 1;
  const startStaffId = Number(ids.maxStaffId) + 1;
  const startCustomerId = Number(ids.maxCustomerId) + 1;
  const startRentalId = Number(ids.maxRentalId) + 1;
  const startPaymentId = Number(ids.maxPaymentId) + 1;

  const lastStoreId = startStoreId + CONFIG.numStores - 1;
  const lastStaffId = startStaffId + CONFIG.numStores - 1;
  const lastPaymentId = startPaymentId + CONFIG.numTransactions - 1;

  console.log("Starting IDs read from your database:");
  console.log(`  store ${startStoreId} | staff ${startStaffId} | customer ${startCustomerId} | rental ${startRentalId} | payment ${startPaymentId}`);
  if (startStoreId !== 3 || startCustomerId !== 600 || startRentalId !== 16050 || startPaymentId !== 16050) {
    console.warn("WARNING: these are not the stock Sakila starting points (3 / 600 / 16050 / 16050).");
    console.warn("         If a failed import left rows behind, delete them first (see the cleanup steps).");
  }

  // ---------------------------------------------------------
  // Work out which ID columns are too small and need widening
  // ---------------------------------------------------------
  const alterStatements = []; // one ALTER TABLE per table that has a column to widen
  for (const group of WIDEN_COLUMNS) {
    const clauses = [];
    for (const column of group.columns) {
      const info = columnRows.find((r) => r.tbl === group.table && r.col === column);
      if (!info) continue;
      const typeKey = info.type.replace(/\(\d+\)/, "").toLowerCase(); // "tinyint(3) unsigned" -> "tinyint unsigned"
      const currentMax = TYPE_MAX[typeKey] || Infinity; // unknown types are assumed big enough
      const needed = column === "payment_id" ? lastPaymentId : Math.max(lastStoreId, lastStaffId);
      if (currentMax >= needed) continue; // already big enough, leave it alone

      const newType = needed <= 65535 ? "SMALLINT UNSIGNED" : "INT UNSIGNED";
      const autoInc = String(info.extra).toLowerCase().includes("auto_increment") ? " AUTO_INCREMENT" : "";
      clauses.push(`MODIFY ${column} ${newType} NOT NULL${autoInc}`);
      console.log(`  widening ${group.table}.${column}: ${info.type} -> ${newType.toLowerCase()} (needs to hold ${needed})`);
    }
    if (clauses.length > 0) alterStatements.push(`ALTER TABLE \`${group.table}\` ${clauses.join(", ")};`);
  }

  // Drop / re-add statements for the foreign keys (only needed when something gets widened)
  const dropFkStatements = [];
  const addFkStatements = [];
  if (alterStatements.length > 0) {
    for (const fk of STANDARD_FKS) {
      const live = fkRows.find((r) => r.tbl === fk.table && r.col === fk.column);
      const name = live ? live.name : fk.name;
      if (live) dropFkStatements.push(`ALTER TABLE \`${fk.table}\` DROP FOREIGN KEY \`${name}\`;`);
      addFkStatements.push(
        `ALTER TABLE \`${fk.table}\` ADD CONSTRAINT \`${name}\` FOREIGN KEY (\`${fk.column}\`) ` +
          `REFERENCES \`${fk.refTable}\` (\`${fk.refColumn}\`) ON DELETE RESTRICT ON UPDATE CASCADE;`
      );
    }
  }

  const out = fs.createWriteStream(CONFIG.outFile, { encoding: "utf8" });

  out.write("-- ============================================================\n");
  out.write("-- Sakila synthetic performance-test data (appended, skewed)\n");
  out.write(`-- Generated: ${new Date().toISOString()}\n`);
  out.write("-- Order: widen ID columns, drop date triggers, load data, re-create triggers\n");
  out.write("-- IF THE IMPORT STOPS EARLY: run the CREATE TRIGGER statements at the bottom\n");
  out.write("-- of this file by hand, otherwise Sakila keeps running without its triggers.\n");
  out.write("-- ============================================================\n\n");

  // ---------------------------------------------------------
  // 1. Widen ID columns (foreign key checks are off only for this step)
  // ---------------------------------------------------------
  if (alterStatements.length > 0) {
    out.write("-- Step 1: widen ID columns that are too small for the new IDs.\n");
    out.write("-- The foreign keys on those columns are dropped first and added back right after.\n");
    for (const sql of dropFkStatements) out.write(sql + "\n");
    for (const sql of alterStatements) out.write(sql + "\n");
    for (const sql of addFkStatements) out.write(sql + "\n");
    out.write("\n");
  }

  // ---------------------------------------------------------
  // 2. Drop the triggers that would overwrite our dates
  // ---------------------------------------------------------
  out.write("-- Step 2: drop the triggers that overwrite create_date / rental_date / payment_date\n");
  for (const t of DATE_TRIGGERS) out.write(`DROP TRIGGER IF EXISTS ${t.name};\n`);
  out.write("\n-- Step 3: load the data\nSET AUTOCOMMIT=0;\n\n");

  // ---------------------------------------------------------
  // 3. STAFF: one manager per new store. Each one starts out pointing at
  //    existing store 1 (valid), and is repointed after the stores exist.
  // ---------------------------------------------------------
  console.log("Generating staff...");
  const staffWriter = new BatchInsertWriter(
    out,
    "staff",
    ["staff_id", "first_name", "last_name", "address_id", "picture", "email", "store_id", "active", "username", "password", "last_update"],
    CONFIG.batchSize
  );

  for (let i = 0; i < CONFIG.numStores; i++) {
    const staffId = startStaffId + i;
    const firstName = faker.person.firstName();
    const lastName = faker.person.lastName();
    const email = makeEmail(firstName, lastName, staffId, "sakilastaff.example");
    const username = `mgr${staffId}`; // short and unique (username is VARCHAR(16))
    const password = faker.string.hexadecimal({ length: 40, prefix: "" }).toLowerCase();
    const lastUpdate = fmtDateTime(randomDate(CONFIG.staffHireStart, CONFIG.staffHireEnd));

    await staffWriter.addRow([
      staffId,
      `'${sqlEscape(firstName)}'`,
      `'${sqlEscape(lastName)}'`,
      pickFrom(existingAddressIds),
      "NULL",
      `'${sqlEscape(email)}'`,
      1, // temporary home store (existing store 1)
      1, // active
      `'${username}'`,
      `'${password}'`,
      `'${lastUpdate}'`,
    ]);
  }
  await staffWriter.flush();

  // ---------------------------------------------------------
  // 4. STORE: 1,000 rows, each managed by one of the new staff (1 to 1)
  // ---------------------------------------------------------
  console.log("Generating stores...");
  const storeWriter = new BatchInsertWriter(out, "store", ["store_id", "manager_staff_id", "address_id", "last_update"], CONFIG.batchSize);

  const newStoreIds = [];
  for (let i = 0; i < CONFIG.numStores; i++) {
    const storeId = startStoreId + i;
    newStoreIds.push(storeId);
    const lastUpdate = fmtDateTime(randomDate(new Date("2024-01-01"), new Date()));
    await storeWriter.addRow([storeId, startStaffId + i, pickFrom(existingAddressIds), `'${lastUpdate}'`]);
  }
  await storeWriter.flush();

  // Now that the stores exist, point each new staff member at the store they manage.
  out.write("-- Point each new staff member at the store they manage\n");
  out.write(
    `UPDATE staff SET store_id = staff_id + (${startStoreId - startStaffId}) ` +
      `WHERE staff_id BETWEEN ${startStaffId} AND ${lastStaffId};\n\n`
  );

  // ---------------------------------------------------------
  // 5. CUSTOMER: 20,000 rows spread over the NEW stores only, with skew
  // ---------------------------------------------------------
  console.log("Generating customers...");
  const customerWriter = new BatchInsertWriter(
    out,
    "customer",
    ["customer_id", "store_id", "first_name", "last_name", "email", "address_id", "active", "create_date", "last_update"],
    CONFIG.batchSize
  );

  const storePicker = buildSkewedPicker(CONFIG.numStores, CONFIG.flagshipStorePct, CONFIG.flagshipStoreShare);
  // The first 1,000 customers cover every store once (in random order),
  // so no store is left without customers. The rest follow the skew.
  const guaranteedStores = faker.helpers.shuffle([...newStoreIds]);

  // We remember each customer's store and signup time for the rentals below.
  const customerStoreId = new Int32Array(CONFIG.numCustomers);
  const customerCreatedMs = new Float64Array(CONFIG.numCustomers);

  for (let i = 0; i < CONFIG.numCustomers; i++) {
    const customerId = startCustomerId + i;
    const storeId = i < CONFIG.numStores ? guaranteedStores[i] : newStoreIds[storePicker.pick()];
    const firstName = faker.person.firstName();
    const lastName = faker.person.lastName();
    const email = makeEmail(firstName, lastName, customerId, "sakilacustomer.example");

    // Signup happens between 08:00 and 09:59, before the stores open at 10:00,
    // so a rental on the signup day can never come before the signup itself.
    const createdAt = randomDate(CONFIG.customerCreateStart, CONFIG.customerCreateEnd);
    createdAt.setUTCHours(randInt(8, 9), randInt(0, 59), randInt(0, 59), 0);

    customerStoreId[i] = storeId;
    customerCreatedMs[i] = createdAt.getTime();

    await customerWriter.addRow([
      customerId,
      storeId,
      `'${sqlEscape(firstName)}'`,
      `'${sqlEscape(lastName)}'`,
      `'${sqlEscape(email)}'`,
      pickFrom(existingAddressIds),
      Math.random() < 0.95 ? 1 : 0,
      `'${fmtDateTime(createdAt)}'`,
      `'${fmtDateTime(createdAt)}'`,
    ]);
  }
  await customerWriter.flush();

  // ---------------------------------------------------------
  // 6. RENTAL + PAYMENT: 100,000 linked pairs
  // ---------------------------------------------------------
  console.log("Generating rentals + payments...");
  const rentalWriter = new BatchInsertWriter(
    out,
    "rental",
    ["rental_id", "rental_date", "inventory_id", "customer_id", "return_date", "staff_id", "last_update"],
    CONFIG.batchSize
  );
  const paymentWriter = new BatchInsertWriter(
    out,
    "payment",
    ["payment_id", "customer_id", "staff_id", "rental_id", "amount", "payment_date", "last_update"],
    CONFIG.batchSize
  );

  const customerPicker = buildSkewedPicker(CONFIG.numCustomers, CONFIG.powerUserPct, CONFIG.powerUserShare);

  // Counters for the summary printed at the end
  const rentalsPerCustomer = new Int32Array(CONFIG.numCustomers);
  const rentalsPerStore = new Int32Array(CONFIG.numStores);
  let weekendRentals = 0;

  for (let i = 0; i < CONFIG.numTransactions; i++) {
    const rentalId = startRentalId + i;
    const paymentId = startPaymentId + i;

    const c = customerPicker.pick(); // 0-based customer index
    const customerId = startCustomerId + c;
    const storeId = customerStoreId[c];
    // The manager of the customer's home store handles the rental and the payment.
    const staffId = startStaffId + (storeId - startStoreId);
    const inventoryId = pickFrom(existingInventoryIds);

    // The rental happens after the customer signed up (and after the rental period starts)
    const earliest = Math.max(customerCreatedMs[c], CONFIG.rentalDateStart.getTime());
    const rentalDate = weekendSkewedDate(new Date(earliest), CONFIG.rentalDateEnd, CONFIG.weekendBiasProb);
    // Stores are open 10:00 to 22:59, so nobody rents at 3 a.m.
    rentalDate.setUTCHours(randInt(10, 22), randInt(0, 59), randInt(0, 59), 0);

    const durationDays = randInt(1, 10);
    const returnDate = new Date(rentalDate.getTime() + durationDays * DAY_MS);

    // Amount is tied to the rental length: daily rate times days, plus a surcharge for long rentals.
    const dailyRate = faker.number.float({ min: CONFIG.dailyRateMin, max: CONFIG.dailyRateMax, fractionDigits: 2 });
    let amount = dailyRate * durationDays;
    if (durationDays >= 7) amount += faker.number.float({ min: 1, max: 5, fractionDigits: 2 });
    amount = Math.round(amount * 100) / 100;

    const paymentDate = new Date(returnDate.getTime() + randInt(0, 2) * DAY_MS);
    const lastUpdate = `'${fmtDateTime(returnDate)}'`;

    await rentalWriter.addRow([
      rentalId,
      `'${fmtDateTime(rentalDate)}'`,
      inventoryId,
      customerId,
      `'${fmtDateTime(returnDate)}'`,
      staffId,
      lastUpdate,
    ]);
    await paymentWriter.addRow([paymentId, customerId, staffId, rentalId, amount, `'${fmtDateTime(paymentDate)}'`, lastUpdate]);

    rentalsPerCustomer[c]++;
    rentalsPerStore[storeId - startStoreId]++;
    const dow = rentalDate.getUTCDay();
    if (dow === 0 || dow === 6) weekendRentals++;

    if (i > 0 && i % 20000 === 0) console.log(`  ...${i} / ${CONFIG.numTransactions}`);
  }
  await rentalWriter.flush();
  await paymentWriter.flush();

  out.write("COMMIT;\nSET AUTOCOMMIT=1;\n\n");

  // ---------------------------------------------------------
  // 7. Put the triggers back exactly as Sakila defines them
  // ---------------------------------------------------------
  out.write("-- Step 4: re-create the triggers we dropped\n");
  for (const t of DATE_TRIGGERS) {
    out.write(`CREATE TRIGGER ${t.name} BEFORE INSERT ON ${t.table} FOR EACH ROW ${t.body};\n`);
  }

  out.end();
  await once(out, "finish");

  // ---------------------------------------------------------
  // Summary (so you can see the skew for yourself)
  // ---------------------------------------------------------
  const noRentals = rentalsPerCustomer.filter((n) => n === 0).length;
  console.log("\nDone. Wrote:", CONFIG.outFile);
  console.log(`  staff ${CONFIG.numStores} (ids ${startStaffId}-${lastStaffId}), stores ${CONFIG.numStores} (ids ${startStoreId}-${lastStoreId})`);
  console.log(`  customers ${CONFIG.numCustomers} (ids ${startCustomerId}-${startCustomerId + CONFIG.numCustomers - 1})`);
  console.log(`  rentals and payments ${CONFIG.numTransactions} (ids ${startRentalId}-${startRentalId + CONFIG.numTransactions - 1} and ${startPaymentId}-${lastPaymentId})`);
  console.log("\nSkew check:");
  console.log(`  busiest 5% of stores handle     ${topShare(rentalsPerStore, 0.05, CONFIG.numTransactions)}% of rentals`);
  console.log(`  busiest 5% of customers make    ${topShare(rentalsPerCustomer, 0.05, CONFIG.numTransactions)}% of rentals`);
  console.log(`  rentals on Saturday or Sunday:  ${((100 * weekendRentals) / CONFIG.numTransactions).toFixed(1)}%`);
  console.log(`  customers with zero rentals:    ${noRentals} of ${CONFIG.numCustomers}`);
}

main().catch((err) => {
  console.error("Generation failed:", err);
  process.exit(1);
});