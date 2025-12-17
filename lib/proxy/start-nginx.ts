import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";

const serviceName = process.env.SERVICE_NAME;
if (!serviceName) {
  throw new Error("SERVICE_NAME environment variable is required");
}

const upstreamHost =
  process.env.UPSTREAM_HOST || `${serviceName}.service.local`;
const upstreamPort = process.env.UPSTREAM_PORT || "9050";
const proxyPort = process.env.PROXY_PORT || "9060";

const resolver = process.env.DNS_RESOLVER || "169.254.169.253";

const nginxConfig = `
resolver ${resolver} valid=10s;
resolver_timeout 5s;

server {
    listen ${proxyPort};
    server_name _;

    set $backend "${upstreamHost}:${upstreamPort}";

    location / {
        proxy_pass http://$backend;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}
`;

mkdirSync("/etc/nginx/conf.d", { recursive: true });
writeFileSync("/etc/nginx/conf.d/default.conf", nginxConfig);

try {
  execSync("nginx -t", { stdio: "inherit" });
} catch {
  console.error("Nginx configuration test failed");
  process.exit(1);
}

execSync("nginx -g 'daemon off;'", { stdio: "inherit" });
