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
- Scheduled backup checks ensure proper scaling

### 🔍 Automatic Service Discovery
- Tasks automatically register with AWS Service Discovery on startup
- Private DNS namespace enables service-to-service communication
- Tasks automatically deregister on shutdown
- DNS resolution: `<SERVICE_NAME>.proxy.local` and `<SERVICE_NAME>.service.local`

### ⚡ Smart Capacity Management
- Automatically scales EC2 capacity when needed
- Detects resource constraints (CPU/MEMORY) and scales up proactively
- Retries with exponential backoff for resilient task launching
- Configurable timeouts and retry policies

## Architecture Components

1. **Fargate Cluster** - Runs stateless proxy containers that reverse proxy to service containers
2. **EC2 Cluster** - Runs service containers with auto-scaling and instance protection
3. **Service Discovery** - Private DNS namespace (`local`) for service-to-service communication
4. **Discovery Lambda** - Automatically registers/deregisters tasks in Service Discovery on task state changes
5. **Autoscaler Lambda** - Scales EC2 cluster based on task load (event-driven + scheduled backup)
6. **Wrapper/Orchestrator** - Next.js API that orchestrates task launches and provides service endpoints

## Container Architecture

**Proxy Container** (Fargate):
- Nginx reverse proxy on port 9060
- Health checks service container with exponential backoff
- Self-destructs if service becomes unhealthy
- Resolves services via DNS: `<SERVICE_NAME>.service.local:9050`

**Service Container** (EC2):
- Nginx serving content on port 9050 (internal only, not directly accessible)
- Health checks proxy container with exponential backoff
- Self-destructs if proxy becomes unhealthy
- Graceful shutdown support
- Runs in private subnets - all access must go through the proxy

## Deployment

```bash
npm install
cdk deploy
```

## Local Testing

```bash
docker-compose up --build
```

Access services through the proxy:
- `http://localhost:9060`

**Note**: Service containers are not directly accessible. All access must go through the proxy container for security and proper routing.

## Configuration

All timing, capacity, and health check parameters are configurable via environment variables with sensible defaults. See individual component files for configuration options.
