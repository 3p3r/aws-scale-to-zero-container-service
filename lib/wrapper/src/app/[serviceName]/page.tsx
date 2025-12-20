"use client";

import { Component } from "react";
import { backOff } from "exponential-backoff";
import type { StatusResponse } from "../../lib/types";

interface ServicePageProps {
  params: Promise<{ serviceName: string }>;
}

interface ServicePageState {
  serviceName: string;
  url: string | null;
  error: string | null;
  isLoading: boolean;
  isPolling: boolean;
}

export default class ServicePage extends Component<
  ServicePageProps,
  ServicePageState
> {
  private mounted: boolean = false;

  constructor(props: ServicePageProps) {
    super(props);
    this.state = {
      serviceName: "",
      url: null,
      error: null,
      isLoading: true,
      isPolling: false,
    };
  }

  async componentDidMount() {
    this.mounted = true;
    await this.init();
  }

  componentWillUnmount() {
    this.mounted = false;
  }

  private async init() {
    const resolvedParams = await this.props.params;
    if (!this.mounted) return;

    const name = resolvedParams.serviceName;
    if (!this.mounted) return;
    this.setState({ serviceName: name });

    try {
      const apiResponse = await fetch(`/api/${name}`);
      if (!this.mounted) return;

      if (
        !apiResponse.ok &&
        apiResponse.status !== 202 &&
        apiResponse.status !== 409
      ) {
        const errorText = await apiResponse.text();
        throw new Error(
          `Failed to launch service: ${apiResponse.status} ${apiResponse.statusText} - ${errorText}`,
        );
      }

      const data: StatusResponse = await apiResponse.json();
      if (!this.mounted) return;

      const serviceUrl = data.url;

      if (data.status === "ready") {
        this.setState({ url: serviceUrl, isLoading: false, isPolling: true });
        await this.pollUrl(serviceUrl);
        return;
      }

      this.setState({ url: serviceUrl, isLoading: false, isPolling: true });
      await this.pollUrl(serviceUrl);
    } catch (err) {
      if (!this.mounted) return;
      this.setState({
        error: err instanceof Error ? err.message : "Failed to launch service",
        isLoading: false,
        isPolling: false,
      });
    }
  }

  private isMixedContentError(url: string, error: unknown): boolean {
    const urlProtocol = new URL(url).protocol;
    const pageProtocol = window.location.protocol;

    if (pageProtocol === "https:" && urlProtocol === "http:") {
      return true;
    }

    if (error instanceof Error) {
      const errorMessage = error.message.toLowerCase();
      if (
        errorMessage.includes("mixed content") ||
        errorMessage.includes("blocked:mixed") ||
        errorMessage.includes("insecure")
      ) {
        return true;
      }
    }

    return false;
  }

  private async pollUrl(url: string) {
    if (!this.mounted) return;

    try {
      await backOff(
        async () => {
          if (!this.mounted) {
            throw new Error("Component unmounted");
          }

          try {
            const response = await fetch(url, {
              method: "GET",
              mode: "no-cors",
            });
            return true;
          } catch (fetchError) {
            if (this.isMixedContentError(url, fetchError)) {
              return true;
            }
            throw fetchError;
          }
        },
        {
          retry: (e) => {
            if (!this.mounted) return false;
            return true;
          },
          numOfAttempts: 30,
          startingDelay: 1000,
          maxDelay: 10000,
        },
      );

      if (!this.mounted) return;
      this.setState({ isPolling: false });
    } catch (err) {
      if (!this.mounted) return;

      if (this.isMixedContentError(url, err)) {
        this.setState({ isPolling: false });
        return;
      }

      this.setState({ isPolling: false });
    }
  }

  render() {
    const { error, isLoading, url, serviceName, isPolling } = this.state;

    if (error) {
      return (
        <div>
          <h1>Error</h1>
          <p>{error}</p>
        </div>
      );
    }

    if (isLoading) {
      return (
        <div>
          <h1>Starting Service {serviceName}</h1>
          <p>Launching service, please wait...</p>
        </div>
      );
    }

    if (url && !isPolling) {
      return (
        <div>
          <h1>Service {serviceName} is Ready</h1>
          <p>Your service has been launched and is now accessible.</p>
          <p>
            <a href={url}>{url}</a>
          </p>
        </div>
      );
    }

    return (
      <div>
        <h1>Starting Service {serviceName}</h1>
        <p>Service is starting up, polling URL...</p>
        {url && (
          <p>
            Service URL: <a href={url}>{url}</a>
          </p>
        )}
      </div>
    );
  }
}
