import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import { APIGatewayProxyEvent } from "aws-lambda";
import * as awsServerlessExpress from "aws-serverless-express";
import { compose, identity } from "fp-ts/lib/function";
import ApolloLambdaContextFromPulumiContext from "./ApolloLambdaContextFromPulumiContext";
import { IFanoutGraphqlTables } from "./FanoutGraphqlApolloConfig";
import {
  FanoutGraphqlExpressServer,
  IFanoutGraphqlServerGripOptions,
} from "./FanoutGraphqlExpressServer";

type APIGatewayEventMiddleware = (
  event: APIGatewayProxyEvent,
) => APIGatewayProxyEvent;

// Will serve graphiql playground. But it has a bug when served at /stage/ on lambda.
// So in that case, we'll need to patch the event.
// via: https://github.com/apollographql/apollo-server/pull/2241#issuecomment-460889307
const playgroundLambdaStageMiddleware: APIGatewayEventMiddleware = (
  event: APIGatewayProxyEvent,
): APIGatewayProxyEvent => {
  const isGetGraphiqlPlayground = event.httpMethod === "GET";
  if (isGetGraphiqlPlayground) {
    console.log("playgroundLambdaStageMiddleware", {
      path: event.path,
      requestContext: event.requestContext,
    });
    return {
      ...event,
      path: (event.requestContext && event.requestContext.path) || event.path,
    };
  }
  // Don't modify event
  return event;
};

/**
 * APIGatewayEventMiddleware that will rewrite events that have base64encoded bodies to not have them.
 * This is useful because apollo-server-lambda doesn't expect to get base64 encoded bodies. It just tries to JSON.parse(event.body).
 * Which throws an error and breaks things.
 */
const base64DecodeBodyMiddleware: APIGatewayEventMiddleware = event => {
  if (!(event.isBase64Encoded && event.body)) {
    return event;
  }
  return {
    ...event,
    body: Buffer.from(event.body, "base64").toString(),
    isBase64Encoded: false,
  };
};

interface IFanoutGraphqlAppLambdaCallbackOptions {
  /** Configure grip */
  grip: false | IFanoutGraphqlServerGripOptions;
  /** objects that store data for the app */
  tables: IFanoutGraphqlTables;
}

/**
 * Create a function that can be used as an AWS Lambda Callback.
 * The function has the functionality of serving a GraphQL API configured by FanoutGraphqlApp.
 */
const FanoutGraphqlAppLambdaCallback = (
  options: IFanoutGraphqlAppLambdaCallbackOptions,
): aws.lambda.Callback<awsx.apigateway.Request, awsx.apigateway.Response> => {
  console.log("FanoutGraphqlAppLambdaCallback", { options });
  const lambdaEventMiddleware = compose(
    playgroundLambdaStageMiddleware,
    base64DecodeBodyMiddleware,
  );
  const handler: aws.lambda.EventHandler<
    awsx.apigateway.Request,
    awsx.apigateway.Response
  > = (event, context, callback) => {
    console.log("FanoutGraphqlAppLambdaCallback - handler start.", {
      context,
      event,
    });
    console.log(
      "FanoutGraphqlAppLambdaCallback - creating FanoutGraphqlExpressServer",
    );
    const fanoutGraphqlExpressServer = FanoutGraphqlExpressServer(options);
    console.log(
      "FanoutGraphqlAppLambdaCallback - calling awsServerlessExpress.proxy",
    );
    const proxyPromise = awsServerlessExpress.proxy(
      awsServerlessExpress.createServer(
        fanoutGraphqlExpressServer.requestListener,
      ),
      lambdaEventMiddleware(event),
      ApolloLambdaContextFromPulumiContext(context),
      "CALLBACK",
      callback,
    ).promise;
    console.log('FanoutGraphqlAppLambdaCallback calling proxyPromise')
    proxyPromise
      .then(result => {
        console.log('FanoutGraphqlAppLambdaCallback proxyPromise result', result)
        callback(null, result)
      })
      .catch((error) => {
        console.log('FanoutGraphqlAppLambdaCallback proxyPromise error', error)
        callback(error)
      });
  };
  return handler;
};

export default FanoutGraphqlAppLambdaCallback;
