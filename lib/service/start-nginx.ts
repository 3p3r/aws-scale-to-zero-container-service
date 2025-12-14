import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";

const nginxConfig = `
server {
    listen 9050;
    server_name _;

    root /usr/share/nginx/html;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }
}
`;

const htmlContent = `
<!DOCTYPE html>
<html>
<head>
    <title>It Works!</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background-color: #f0f0f0;
        }
        .container {
            text-align: center;
            background: white;
            padding: 2rem;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h1 {
            color: #333;
            margin-bottom: 1rem;
        }
        p {
            color: #666;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>It Works!</h1>
        <p>Service container is running successfully.</p>
    </div>
</body>
</html>
`;

mkdirSync("/usr/share/nginx/html", { recursive: true });
mkdirSync("/etc/nginx/conf.d", { recursive: true });
writeFileSync("/usr/share/nginx/html/index.html", htmlContent);
writeFileSync("/etc/nginx/conf.d/default.conf", nginxConfig);

try {
  execSync("nginx -t", { stdio: "inherit" });
} catch (error) {
  console.error("Nginx configuration test failed");
  process.exit(1);
}

execSync("nginx -g 'daemon off;'", { stdio: "inherit" });
