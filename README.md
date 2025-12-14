# AWS Scale-To-Zero Container Service

A scale-to-zero container service pattern in AWS using ECS, Service Discovery, and Lambda.

## Architecture

### Components

1. **Fargate Cluster** - Runs proxy containers that reverse proxy to service containers
2. **EC2 Cluster** - Runs service containers with auto-scaling and instance protection
3. **Service Discovery** - Private DNS namespace (`local`) for service-to-service communication
4. **Discovery Lambda** - Automatically registers/deregisters tasks in Service Discovery on task state changes
5. **Autoscaler Lambda** - Scales EC2 cluster based on task load (max 3 tasks per instance)
6. **Wrapper/Orchestrator** - Next.js application for orchestrating tasks and authentication

### Container Details

**Proxy Container** (`lib/proxy`):
- Nginx reverse proxy listening on port 9060
- Health checks service container with exponential backoff
- Shuts down if service becomes unhealthy (5 consecutive failures)
- Resolves service via Service Discovery: `<SERVICE_NAME>.service.local:9050`

**Service Container** (`lib/service`):
- Nginx serving static content on port 9050
- Watches `/tmp/shutdown` file for graceful shutdown
- Managed by Supervisor for process management

### Service Discovery

- **Namespace**: `local`
- **Fargate tasks**: Registered as `<SERVICE_NAME>.proxy.local`
- **EC2 tasks**: Registered as `<SERVICE_NAME>.service.local`
- Tasks are automatically registered when they start and deregistered when they stop

### Auto-Scaling

- EC2 cluster scales based on running task count
- Maximum 3 tasks per EC2 instance
- Instances with running tasks are protected from scale-in
- Scales to zero when no tasks are running

### Event Flow

1. ECS task state changes trigger EventBridge events
2. Discovery Lambda registers/deregisters tasks in Service Discovery
3. Autoscaler Lambda evaluates EC2 cluster capacity and adjusts ASG
4. Proxy containers discover service containers via DNS
5. Health checks monitor service availability with exponential backoff

## Requirements

- `SERVICE_NAME` environment variable must be set when running tasks (via container overrides)
- Tasks must be run in the configured VPC with Service Discovery namespace access

## Local Testing

Use `docker-compose.yml` to test containers locally:

```bash
docker-compose up --build
```

Access:
- Service directly: `http://localhost:9050`
- Through proxy: `http://localhost:9060`

## Deployment

Deploy with AWS CDK:

```bash
npm install
cdk deploy
```

## Notes

- This example does not include HTTPS/SSL termination
- For production, extend the proxy container to include SSL termination
- Certificates should remain in the proxy container for security isolation
- ACM certificates cannot be exported, so use alternative certificate management for Fargate tasks
