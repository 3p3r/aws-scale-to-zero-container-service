# aws-scale-to-zero-container-service

Scale-To-Zero Container Service pattern in AWS.

## architecture

Three main components are used to implement this pattern:

1. A Fargate Task ([proxy container](lib/proxy))
2. An AWS ECS Task ([service container](lib/service))
3. A Lambda Function ([wrapper orchestrator](lib/orchestrator))

The Fargate Task is responsible for reverse proxying requests to the ECS task.

The Lambda Function is responsible for orchestrating both tasks and auth.

This solution assumes one container duopoly (proxy + service) per login session managed by the wrapper Lambda function.

This solution performs its own autoscaling and instance termination protection.

## why two containers?

This example does not use HTTPS or SSL termination. For this pattern to work in a production environment, you will need to extend the Fargate Task to include SSL termination.

For SSL termination, you will need certificates physically available in the Fargate Task. Merging the two containers put you at risk of exposing your certificates if the service container is compromised.

You will not be able to use AWS Certificate Manager (ACM) certificates in the Fargate Task, as ACM certificates cannot be exported. Even if you did, you will need Load Balancers involved, which cannot scale to zero in reasonable times at the time of writing.
