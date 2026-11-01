import { config, envResolutionProblems as configEnvProblems, validateDeploymentConfig } from "./config.js";
import { createApp } from "./app.js";

async function main(): Promise<void> {
  // Validate configuration before accepting any request. Problems are reported
  // without printing secret values; the process exits non-zero.
  const problems = validateDeploymentConfig({
    deploymentEnv: config.deploymentEnv,
    envProblems: configEnvProblems,
    accountsFlagProblem: config.accountsFlagProblem,
    authAccountsEnabled: config.authAccountsEnabled,
    sessionSecret: config.sessionSecret,
    smtpHost: config.smtp.host,
    smtpPort: config.smtp.port,
    smtpUser: config.smtp.user,
    smtpPassword: config.smtp.password,
    smtpFrom: config.smtp.from,
    allowDevEmailPreview: config.allowDevEmailPreview,
  });
  if (problems.length > 0) {
    console.error(`[empire] refusing to start (EMPIRE_ENV=${config.deploymentEnv}); configuration problems:`);
    for (const p of problems) console.error(`  - [${p.area}] ${p.message}`);
    process.exit(1);
  }
  const handle = createApp();
  const port = await handle.listen();
  console.log(`[empire] API listening on http://localhost:${port} (env: ${config.nodeEnv})`);
  const shutdown = async () => {
    console.log("\n[empire] shutting down…");
    await handle.close(); // closes both server and db
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[empire] failed to start:", err);
  process.exit(1);
});
