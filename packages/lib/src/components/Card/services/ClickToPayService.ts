import requestSecureRemoteCommerceInitData from '../../../core/Services/click-to-pay/secure-remote-commerce-init';
import { ISrcInitiator } from './sdks/AbstractSrcInitiator';
import { InitiateIdentityValidationResponse, InitParams, IsRecognizedResponse } from './types';
import { getSchemaSdk } from './utils';

export enum CtpState {
    Idle = 'Idle',
    Loading = 'Loading',
    NotAvailable = 'NotAvailable',
    AwaitingSignIn = 'AwaitingSignIn',
    OneTimePassword = 'OneTimePassword',
    Ready = 'Ready',
    Checkout = 'Checkout'
}

type CallbackStateSubscriber = (state: CtpState) => void;

type ShopperIdentity = {
    value: string;
    type: string;
};

interface IClickToPayService {
    maskedCards: any;

    initialize(): Promise<void>;
    // TODO: checkout(): Promise<???>

    subscribeOnStatusChange(callback): void;

    // identification flow
    startIdentityValidation(): Promise<InitiateIdentityValidationResponse>;
    abortIdentityValidation(): void;
    finishIdentityValidation(otpCode: string): Promise<any>;
}

class ClickToPayService implements IClickToPayService {
    private schemas: string[];
    private sdks: ISrcInitiator[];
    private readonly shopperIdentity?: ShopperIdentity;

    private state: CtpState = CtpState.Idle;
    private stateSubscriber: CallbackStateSubscriber;

    private srcProfile: any;

    private validationSchemaSdk: ISrcInitiator = null;

    constructor(schemas: string[], environment: string, shopperIdentity?: ShopperIdentity) {
        this.schemas = schemas;
        this.sdks = this.schemas.map(schema => getSchemaSdk(schema, environment));
        this.shopperIdentity = shopperIdentity;
    }

    public get maskedCards() {
        return this.srcProfile?.maskedCards;
    }

    public async initialize(): Promise<void> {
        this.setState(CtpState.Loading);

        try {
            await this.loadSdkScripts();
            const initParams = await this.fetchSrcInitParameters();
            await this.initiateSdks(initParams);

            const { recognized = false, idTokens = null } = await this.recognizeShopper();

            if (recognized) {
                await this.getSecureRemoteCommerceProfile(idTokens);
                this.setState(CtpState.Ready);
                return;
            }

            if (!this.shopperIdentity) {
                this.setState(CtpState.NotAvailable);
                return;
            }

            const isEnrolled = await this.identifyShopper();

            if (isEnrolled) this.setState(CtpState.AwaitingSignIn);
            else this.setState(CtpState.NotAvailable);
        } catch (error) {
            console.error(error);
            this.setState(CtpState.NotAvailable);
        }
    }

    public subscribeOnStatusChange(callback): void {
        this.stateSubscriber = callback;
    }

    /**
     * Initiates Consumer Identity validation with one Click to Pay System.
     * The Click to Pay System sends a one-time-password (OTP) to the registered email address or mobile number.
     *
     * This method uses only the SDK that responded first on identifyShopper() call. There is no need to use all SDK's
     */
    public async startIdentityValidation(): Promise<InitiateIdentityValidationResponse> {
        if (!this.validationSchemaSdk) {
            throw Error('initiateIdentityValidation: No schema set for the validation process');
        }

        const maskedData = await this.validationSchemaSdk.initiateIdentityValidation();
        this.setState(CtpState.OneTimePassword);
        return maskedData;
    }

    public abortIdentityValidation() {
        this.setState(CtpState.AwaitingSignIn);
    }

    /**
     * Completes the validation of a Consumer Identity, by evaluating the supplied OTP.
     * This method uses only the SDK that responded first on identifyShopper() call. There is no need to use all SDK's
     */
    public async finishIdentityValidation(otpCode: string): Promise<any> {
        if (!this.validationSchemaSdk) {
            throw Error('finishIdentityValidation: No schema set for the validation process');
        }
        const validationToken = await this.validationSchemaSdk.completeIdentityValidation(otpCode);
        await this.getSecureRemoteCommerceProfile([validationToken.idToken]);
        this.validationSchemaSdk = null;
    }

    private async getSecureRemoteCommerceProfile(idTokens: string[]): Promise<void> {
        const srcProfilesPromises = this.sdks.map(sdk => sdk.getSrcProfile(idTokens));
        const srcProfiles = await Promise.all(srcProfilesPromises);

        // TODO: verify when APi return multiple profiles. What to do with that?
        // For now it is taking only the first one of the first response
        this.srcProfile = srcProfiles[0]?.profiles[0];
        console.log(srcProfiles[0]);
        this.setState(CtpState.Ready);
    }

    private setState(state: CtpState): void {
        this.state = state;

        if (this.stateSubscriber) {
            this.stateSubscriber(this.state);
        }
    }

    /**
     * Checks if the consumer is recognized by any of the Click to Pay System
     * If recognized, it takes the first one in the response and uses its token
     */
    private async recognizeShopper(): Promise<IsRecognizedResponse> {
        const recognizingPromises = this.sdks.map(sdk => sdk.isRecognized());
        const recognizeResponses = await Promise.all(recognizingPromises);

        const isRecognizedResp = recognizeResponses.find(response => response.recognized);
        return isRecognizedResp || { recognized: false };
    }

    /**
     * Call the identityLookup() method of each SRC SDK.
     *
     * Based on the responses from the Click to Pay Systems, we should call the
     * initiateIdentityValidation() SDK method of the Click to Pay System that
     * responds first with consumerPresent response to the identityLookup() call
     */
    private async identifyShopper(): Promise<boolean> {
        const identifyLookupPromises = this.sdks.map(sdk =>
            sdk.identityLookup({ value: this.shopperIdentity.value, type: this.shopperIdentity.type })
        );
        const identifyLookupResponses = await Promise.all(identifyLookupPromises);

        // Find the index of the first schema that returns consumerPresent
        const schemaIndex = identifyLookupResponses.findIndex(response => response.consumerPresent);
        this.validationSchemaSdk = this.sdks[schemaIndex];

        return this.validationSchemaSdk !== null;
    }

    private async loadSdkScripts() {
        const promises = this.sdks.map(sdk => sdk.loadSdkScript());
        return Promise.all(promises);
    }

    private async initiateSdks(initParams: InitParams[]): Promise<void> {
        const initResponsesPromise = initParams.map((initParam, index) => this.sdks[index].init(initParam));
        await Promise.all(initResponsesPromise);
    }

    private async fetchSrcInitParameters() {
        const requestSrcPromises = this.schemas.map(schema => requestSecureRemoteCommerceInitData(schema));
        const responses = await Promise.all(requestSrcPromises);
        return responses;
    }
}

export default ClickToPayService;
