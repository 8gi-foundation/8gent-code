/**
 * ETL fixture data — messy CSV with realistic data quality issues.
 * Used by DP001 benchmark.
 */

export const CUSTOMERS_CSV = `id,email,name,phone,created_at
C001,alice@example.com,Alice Johnson,+1-555-0101,2024-01-15
C002,bob@example.com,Bob Smith,(555) 0102,01/20/2024
C003,carol@example.com,Carol White,5550103,February 3, 2024
C004,alice@example.com,Alice M. Johnson,+15550101,2024-01-20
C005,dave@example.com,Dave Brown,,2024-02-10
C006,eve@example.com,"Eve Davis, Jr.",555.010.6,March 15, 2024
C007,frank@example.com,Frank Miller,+1 (555) 010-7,2024-03-20
C008,,Ghost User,5550108,2024-04-01
C009,invalid-email,Bad Email,5550109,2024-04-15
C010,grace@example.com,Grace Lee,+15550110,not-a-date
C011,bob@example.com,Robert Smith,555-0102,2024-03-01
C012,heidi@example.com,"Heidi O'Brien",+15550112,2024-05-01
C013,ivan@example.com,Ivan Petrov,+7-495-555-0113,2024-05-15
extra-col,mallory@example.com,Mallory,5550114,2024-06-01,EXTRA
C015,nancy@example.com,Nancy Chen,+86-10-5550115,15 Jun 2024
`;

export const PRODUCTS_CSV = `\ufeffid,name,price,category
P001,Widget A,"$12.99",electronics
P002,Widget B,"24.50 USD",electronics
P003,Gadget C,"1.234,56",home
P004,Doohickey D,$0.99,toys
P005,Thingamajig E,"$1,000.00",electronics
P006,Widget F,$15.00,home
P007,"Widget ""G""","\u20ac29.99",electronics
`;

export const ORDERS_CSV = `order_id,customer_id,product_id,quantity,total,order_date
O001,C001,P001,2,"$25.98",2024-02-01
O002,C002,P002,1,$24.50,01/25/2024
O003,C003,P001,3,"$38.97",2024-02-15
O004,C001,P005,1,"$1,000.00",March 1, 2024
O005,C999,P001,1,$12.99,2024-03-10
O006,C002,P999,2,$49.00,2024-03-15
O007,C005,P003,1,"1.234,56",20 Mar 2024
O008,C001,P002,1,$24.50,2024-04-01
O009,C006,P004,10,$9.90,2024-04-15
O010,C002,P001,"three","$38.97",2024-05-01
O011,C007,P006,2,$30.00,2024-05-15
O012,C012,P001,1,$12.99,2024-06-01
O013,C001,P004,5,$4.95,2024-06-15
O014,C013,P002
O015,C015,P005,1,"$1,000.00",2024-07-01
`;

/**
 * Expected results after ETL:
 *
 * Valid customers (after dedup + cleanup): C001/C004 merged (keep C004 newer, merge phone),
 *   C002/C011 merged (keep C011), C003, C005, C006, C007, C012, C013, C015
 *   Dropped: C008 (no email), C009 (invalid email), C010 (invalid date), C014 (extra columns)
 *
 * Valid orders: O001, O002, O003, O004, O007, O008, O009, O011, O012, O013, O015
 *   Dropped: O005 (customer C999 doesn't exist), O006 (product P999 doesn't exist),
 *     O010 (invalid quantity), O014 (missing columns)
 *
 * Revenue per customer (valid orders only):
 *   C001 (Alice): O001($25.98) + O004($1000) + O008($24.50) + O013($4.95) = $1055.43
 *   C002/C011 (Bob/Robert): O002($24.50) = $24.50
 *   C003 (Carol): O003($38.97) = $38.97
 *   C005 (Dave): O007($1234.56) = $1234.56
 *   C006 (Eve): O009($9.90) = $9.90
 *   C007 (Frank): O011($30.00) = $30.00
 *   C012 (Heidi): O012($12.99) = $12.99
 *   C015 (Nancy): O015($1000) = $1000.00
 */
