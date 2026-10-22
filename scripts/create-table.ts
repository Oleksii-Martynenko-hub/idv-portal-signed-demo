import { loadDynamoDBConfig } from "../src/config.js";
import { createDynamoDBClient, ensureTable, TTL_ATTRIBUTE } from "../src/storage/dynamodb.js";

const config = loadDynamoDBConfig(process.env);
const client = createDynamoDBClient({ region: config.awsRegion, endpoint: config.dynamodbEndpoint });

const outcome = await ensureTable(client, config.dynamodbTable);
console.log(
  outcome === "created"
    ? `Created table "${config.dynamodbTable}" (on-demand capacity, TTL on "${TTL_ATTRIBUTE}").`
    : `Table "${config.dynamodbTable}" already exists; TTL on "${TTL_ATTRIBUTE}" is enabled.`,
);
