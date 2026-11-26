import { Controller, Get } from "@nestjs/common";



@Controller("rabbitmq")
export class RabbitMQ {
    @Get('health')
    health() {
        return { status: 'ok', service: 'dev' };
    }
}