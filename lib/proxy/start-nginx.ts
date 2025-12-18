import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";

const upstreamHost = process.env.UPSTREAM_HOST;
if (!upstreamHost) {
  throw new Error("UPSTREAM_HOST environment variable is required");
}
const upstreamPort = process.env.UPSTREAM_PORT || "9050";
const proxyPort = process.env.PROXY_PORT || "9060";

console.log(`Proxy config: upstream=${upstreamHost}:${upstreamPort}`);

const nginxConfig = `
upstream backend {
    server ${upstreamHost}:${upstreamPort};
}

server {
    listen ${proxyPort};
    server_name _;

    # Health check endpoint that always returns 200 (for ECS health checks)
    location = /health {
        access_log off;
        default_type text/plain;
        return 200 'OK';
    }

    location / {
        proxy_pass http://backend;
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
