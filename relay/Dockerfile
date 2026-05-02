FROM golang:1.23-alpine AS builder

WORKDIR /app

# Cache dependency downloads
COPY go.mod go.sum ./
RUN go mod download

# Build static binary
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /relay ./cmd/relay

# Minimal runtime image
FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=builder /relay /relay

EXPOSE 8080
CMD ["/relay"]
