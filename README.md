# AWS Scale-To-Zero Container Service

A serverless scale-to-zero container service pattern in AWS that automatically launches and scales containerized services on-demand, scaling to zero when idle.

![Architecture Diagram](diagram.png)

## Key Features

### 🚀 On-Demand Service Launch
- Services are launched automatically when requested via HTTP endpoint
- Each service consists of a Fargate proxy container and an EC2 service container
- Services scale to zero when idle, eliminating idle costs

### 🔄 Bidirectional Health Monitoring
- **Proxy → Service**: Proxy monitors service health and self-destructs if service becomes unavailable
- **Service → Proxy**: Service monitors proxy health and self-destructs if proxy becomes unavailable
- Uses exponential backoff for resilient health checking
- Grace periods prevent premature shutdowns during startup

### 📊 Intelligent Auto-Scaling
- EC2 cluster automatically scales based on task load
- Configurable maximum tasks per instance (default: 3)
- Instances with running tasks are protected from scale-in
- Scales to zero when no tasks are running

### 🔍 Automatic DNS Registration
- Proxy containers register with Route53 on startup using their public IP
- Services accessible via `<SERVICE_NAME>.<DOMAIN>:9060`
- DNS records automatically cleaned up when tasks stop
- Private namespace for internal service-to-proxy communication

## Architecture Components

1. **Fargate Cluster** - Runs stateless proxy containers with public IPs
2. **EC2 Cluster** - Runs service containers with auto-scaling
3. **Route53** - Public DNS for proxy access (`<service>.<domain>`)
4. **Discovery Lambda** - Adjusts locks, cleans up Route53 on task stop
5. **Autoscaler Lambda** - Scales EC2 cluster based on task load
6. **Wrapper** - Next.js API that orchestrates task launches

## Container Architecture

**Proxy Container** (Fargate):
- Nginx reverse proxy on port 9060
- Registers with Route53 on startup
- Health checks service container
- Self-destructs if service becomes unhealthy

**Service Container** (EC2):
- Nginx serving content on port 9050
- Health checks proxy container
- Self-destructs if proxy becomes unhealthy

## Deployment

```bash
npm install
cdk deploy -c domain=pleadables.chat
```

## Local Testing

```bash
docker-compose up --build
```

Access services through the proxy:
- `http://localhost:9060`

## Configuration

All timing, capacity, and health check parameters are configurable via environment variables with sensible defaults.
