CREATE DATABASE finance_mco1;
USE finance_mco1;

-- creation of tables
CREATE TABLE account (
    account_key INT AUTO_INCREMENT PRIMARY KEY,
    account_id INT NOT NULL UNIQUE,
    account_frequency VARCHAR(50),
    account_open_date DATE,
    district_id INT,
    district_name VARCHAR(100),
    region VARCHAR(100)
);

CREATE TABLE `date` (
    date_key INT PRIMARY KEY,
    full_date DATE NOT NULL,
    day_number INT,
    month_number INT,
    month_name VARCHAR(20),
    quarter_number INT,
    year_number INT
);

CREATE TABLE transaction_type (
    type_key INT AUTO_INCREMENT PRIMARY KEY,
    transaction_type VARCHAR(100) NOT NULL UNIQUE
);

CREATE TABLE transaction_operation (
    operation_key INT AUTO_INCREMENT PRIMARY KEY,
    operation_name VARCHAR(150) NOT NULL UNIQUE
);

CREATE TABLE transaction_fact (
    trans_id INT PRIMARY KEY,
    date_key INT,
    account_key INT,
    type_key INT,
    operation_key INT,
    amount DOUBLE,
    balance DOUBLE,

    FOREIGN KEY (date_key)
        REFERENCES `date`(date_key),

    FOREIGN KEY (account_key)
        REFERENCES account(account_key),

    FOREIGN KEY (type_key)
        REFERENCES transaction_type(type_key),

    FOREIGN KEY (operation_key)
        REFERENCES transaction_operation(operation_key)
);