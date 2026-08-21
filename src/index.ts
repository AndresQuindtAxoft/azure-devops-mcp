#!/usr/bin/env node

// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getBearerHandler, getPersonalAccessTokenHandler, WebApi } from "azure-devops-node-api";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { createAuthenticator } from "./auth.js";
import { logger } from "./logger.js";
import { getOrgTenant } from "./org-tenants.js";
//import { configurePrompts } from "./prompts.js";
import { configureAllTools } from "./tools.js";
import { UserAgentComposer } from "./useragent.js";
import { packageVersion } from "./version.js";
import { DomainsManager } from "./shared/domains.js";
import { initializeServerContext } from "./shared/server-context.js";

function isGitHubCodespaceEnv(): boolean {
  return process.env.CODESPACES === "true" && !!process.env.CODESPACE_NAME;
}

const defaultAuthenticationType = isGitHubCodespaceEnv() ? "azcli" : "interactive";

// Allow self-signed certificates for on-premises TFS/Azure DevOps Server
// Only disable SSL verification if explicitly requested via environment variable
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined && process.env.AZURE_DEVOPS_IGNORE_SSL_ERRORS === "true") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

// Parse command line arguments using yargs
const argv = yargs(hideBin(process.argv))
  .scriptName("mcp-server-azuredevops")
  .usage("Usage: $0 <organization> [options]")
  .version(packageVersion)
  .command("$0 <organization> [options]", "Azure DevOps MCP Server", (yargs) => {
    yargs.positional("organization", {
      describe: "Azure DevOps organization name (cloud, e.g. 'contoso') or full URL for on-premises installations (e.g. 'https://tfs.company.com/DefaultCollection')",
      type: "string",
      demandOption: true,
    });
  })
  .option("domains", {
    alias: "d",
    describe: "Domain(s) to enable: 'all' for everything, or specific domains like 'repositories builds work'. Defaults to 'all'.",
    type: "string",
    array: true,
    default: "all",
  })
  .option("authentication", {
    alias: "a",
    describe: "Type of authentication to use",
    type: "string",
    choices: ["interactive", "azcli", "env", "envvar"],
    default: defaultAuthenticationType,
  })
  .option("tenant", {
    alias: "t",
    describe: "Azure tenant ID (optional, applied when using 'interactive' and 'azcli' type of authentication)",
    type: "string",
  })
  .help()
  .parseSync();

// ORCA_AZURE_DEVOPS_API_BASE_URL lets an ORCA-provisioned on-premises Azure DevOps Server / TFS
// deployment override both the cloud organization name and the explicit on-premises URL argument.
const orcaApiBaseUrl = process.env.ORCA_AZURE_DEVOPS_API_BASE_URL;
const organizationArgument = argv.organization as string;

// Determine organization URL based on the ORCA override or CLI input. A full URL denotes
// Azure DevOps Server/TFS; a bare value denotes an Azure DevOps Services organization.
const explicitServerUrl = orcaApiBaseUrl || (organizationArgument.includes("://") ? organizationArgument : undefined);
const orgUrl = explicitServerUrl ? explicitServerUrl.replace(/\/$/, "") : "https://dev.azure.com/" + organizationArgument;
let orgName: string;
const isOnPremise = explicitServerUrl !== undefined;

if (isOnPremise) {
  const urlParts = orgUrl.replace(/\/$/, "").split("/");
  orgName = urlParts[urlParts.length - 1];
} else {
  orgName = organizationArgument;
}

const isPATAuth = !!(process.env.ORCA_AZURE_DEVOPS_TOKEN || process.env.AZURE_DEVOPS_PAT);

// Initialize centralized server context (used by tools that need deployment-aware behavior)
initializeServerContext({ orgUrl, orgName, isOnPremise, isPATAuth });

export { orgName, isOnPremise };

const domainsManager = new DomainsManager(argv.domains);
export const enabledDomains = domainsManager.getEnabledDomains();

function getAzureDevOpsClient(getAzureDevOpsToken: () => Promise<string>, userAgentComposer: UserAgentComposer): () => Promise<WebApi> {
  return async () => {
    const accessToken = await getAzureDevOpsToken();
    // ORCA_AZURE_DEVOPS_TOKEN and AZURE_DEVOPS_PAT are PATs and must use HTTP Basic auth.
    const isPAT = process.env.ORCA_AZURE_DEVOPS_TOKEN || process.env.AZURE_DEVOPS_PAT;
    const authHandler = isPAT ? getPersonalAccessTokenHandler(accessToken) : getBearerHandler(accessToken);
    const connection = new WebApi(orgUrl, authHandler, undefined, {
      productName: "AzureDevOps.MCP",
      productVersion: packageVersion,
      userAgent: userAgentComposer.userAgent,
    });
    return connection;
  };
}

async function main() {
  logger.info("Starting Azure DevOps MCP Server", {
    organization: orgName,
    organizationUrl: orgUrl,
    authentication: argv.authentication,
    tenant: argv.tenant,
    domains: argv.domains,
    enabledDomains: Array.from(enabledDomains),
    version: packageVersion,
    isCodespace: isGitHubCodespaceEnv(),
  });

  const server = new McpServer({
    name: "Azure DevOps MCP Server",
    version: packageVersion,
    icons: [
      {
        src: "https://cdn.vsassets.io/content/icons/favicon.ico",
      },
    ],
  });

  const userAgentComposer = new UserAgentComposer(packageVersion);
  server.server.oninitialized = () => {
    userAgentComposer.appendMcpClientInfo(server.server.getClientVersion());
  };
  // Skip the cloud tenant lookup (a network call to dev.azure.com) when an ORCA-provisioned
  // on-premises base URL or token is in play; tenantId is only meaningful for cloud OAuth/az-cli auth.
  const tenantId = orcaApiBaseUrl || process.env.ORCA_AZURE_DEVOPS_TOKEN ? argv.tenant : ((await getOrgTenant(orgName)) ?? argv.tenant);
  const authenticator = createAuthenticator(argv.authentication, tenantId);

  // removing prompts untill further notice
  // configurePrompts(server);

  configureAllTools(server, authenticator, getAzureDevOpsClient(authenticator, userAgentComposer), () => userAgentComposer.userAgent, enabledDomains);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  logger.error("Fatal error in main():", error);
  process.exit(1);
});
