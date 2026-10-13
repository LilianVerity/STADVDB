-- loading of data into warehouse
INSERT INTO account (
    account_id,
    account_frequency,
    account_open_date,
    district_id,
    district_name,
    region
)
SELECT
    a.account_id,
    a.frequency,
    a.newdate,
    a.district_id,
    d.district_name,
    d.region
FROM financedata.account AS a
LEFT JOIN financedata.district AS d
    ON a.district_id = d.district_id;

INSERT INTO `date` (
    date_key,
    full_date,
    day_number,
    month_number,
    month_name,
    quarter_number,
    year_number
)
SELECT DISTINCT
    YEAR(t.newdate) * 10000
        + MONTH(t.newdate) * 100
        + DAY(t.newdate) AS date_key,
    t.newdate AS full_date,
    DAY(t.newdate) AS day_number,
    MONTH(t.newdate) AS month_number,
    MONTHNAME(t.newdate) AS month_name,
    QUARTER(t.newdate) AS quarter_number,
    YEAR(t.newdate) AS year_number
FROM financedata.trans AS t
WHERE t.newdate IS NOT NULL;

INSERT INTO transaction_type (transaction_type)
SELECT DISTINCT t.type
FROM financedata.trans AS t
WHERE t.type IS NOT NULL;

INSERT INTO transaction_operation (operation_name)
SELECT DISTINCT t.operation
FROM financedata.trans AS t
WHERE t.operation IS NOT NULL;

INSERT INTO transaction_fact (
    trans_id,
    date_key,
    account_key,
    type_key,
    operation_key,
    amount,
    balance
)
SELECT
    t.trans_id,
    d.date_key,
    a.account_key,
    tt.type_key,
    op.operation_key,
    t.amount,
    t.balance
FROM financedata.trans AS t
LEFT JOIN finance_mco1.`date` AS d
    ON t.newdate = d.full_date
LEFT JOIN finance_mco1.account AS a
    ON t.account_id = a.account_id
LEFT JOIN finance_mco1.transaction_type AS tt
    ON t.type = tt.transaction_type
LEFT JOIN finance_mco1.transaction_operation AS op
    ON t.operation = op.operation_name;