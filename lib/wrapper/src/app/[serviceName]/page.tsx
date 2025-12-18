"use client";

import { Component } from "react";
import delay from "delay";

interface StatusResponse {
  status: "ready" | "starting";
  proxyRunning: boolean;
  serviceRunning: boolean;
  proxyTask?: string;
  serviceTask?: string;
  serviceIp?: string;
  url: string;
  isAccessible: boolean;
}

interface ServicePageProps {
  params: Promise<{ serviceName: string }>;
}

interface ServicePageState {
  serviceName: string;
  status: StatusResponse | null;
  error: string | null;
  isLoading: boolean;
}

export default class ServicePage extends Component<
  ServicePageProps,
  ServicePageState
> {
  private mounted: boolean = false;
  private polling: boolean = false;

  constructor(props: ServicePageProps) {
    super(props);
    this.state = {
      serviceName: "",
      status: null,
      error: null,
      isLoading: true,
    };
  }

  async componentDidMount() {
    this.mounted = true;
    await this.init();
  }

  componentWillUnmount() {
    this.mounted = false;
    this.polling = false;
  }

  private async init() {
    const resolvedParams = await this.props.params;
    if (!this.mounted) return;

    const name = resolvedParams.serviceName;
    if (!this.mounted) return;
    this.setState({ serviceName: name });

    // First, trigger the launcher route
    try {
      const launchResponse = await fetch(`/api/${name}`);
      // 202 Accepted is OK - it means service is launching
      if (!launchResponse.ok && launchResponse.status !== 202) {
        const errorText = await launchResponse.text();
        throw new Error(
          `Failed to launch service: ${launchResponse.status} ${launchResponse.statusText} - ${errorText}`,
        );
      }
      // If we got a 200, the service is already ready
      if (launchResponse.ok && launchResponse.status === 200) {
        const data: StatusResponse = await launchResponse.json();
        if (data.status === "ready" && data.isAccessible) {
          if (!this.mounted) return;
          this.setState({ status: data, isLoading: false });
          return;
        }
      }
    } catch (err) {
      if (!this.mounted) return;
      this.setState({
        error: err instanceof Error ? err.message : "Failed to launch service",
        isLoading: false,
      });
      return;
    }

    // Then start polling the status endpoint
    this.pollStatus(name);
  }

  private pollStatus(name: string) {
    const statusUrl = `/api/${name}?status=true`;
    this.polling = true;
    this.checkStatus(statusUrl);
  }

  private async checkStatus(statusUrl: string) {
    if (!this.polling || !this.mounted) return;

    try {
      const response = await fetch(statusUrl);
      if (!this.mounted) return;

      if (!response.ok) {
        // Don't treat 202 as an error - it just means still starting
        if (response.status === 202) {
          const data: StatusResponse = await response.json();
          if (!this.mounted) return;
          this.setState({ status: data, isLoading: false });
          await delay(2000);
          if (this.mounted && this.polling) {
            this.checkStatus(statusUrl);
          }
          return;
        }
        throw new Error(`Status check failed: ${response.statusText}`);
      }

      const data: StatusResponse = await response.json();
      if (!this.mounted) return;
      this.setState({ status: data, isLoading: false });

      if (data.status === "ready" && data.isAccessible) {
        // Service is ready, stop polling
        this.polling = false;
        return;
      }

      // Continue polling
      await delay(2000);
      if (this.mounted && this.polling) {
        this.checkStatus(statusUrl);
      }
    } catch (err) {
      if (!this.mounted) return;
      this.setState({
        error: err instanceof Error ? err.message : "Failed to check status",
        isLoading: false,
      });
      this.polling = false;
    }
  }

  render() {
    const { error, isLoading, status, serviceName } = this.state;

    if (error) {
      return (
        <div>
          <h1>Error</h1>
          <p>{error}</p>
        </div>
      );
    }

    if (isLoading || !status) {
      return (
        <div>
          <h1>Starting Service {serviceName}</h1>
          <p>Launching service, please wait...</p>
        </div>
      );
    }

    if (status.status === "ready" && status.isAccessible) {
      return (
        <div>
          <h1>Service {serviceName} is Ready</h1>
          <p>Your service has been launched and is now accessible.</p>
          <p>
            <a href={status.url}>{status.url}</a>
          </p>
        </div>
      );
    }

    return (
      <div>
        <h1>Starting Service {serviceName}</h1>
        <p>
          Service is starting up... (Proxy:{" "}
          {status.proxyRunning ? "running" : "starting"}, Service:{" "}
          {status.serviceRunning ? "running" : "starting"})
        </p>
      </div>
    );
  }
}
