import type {
  PcoListResponse,
  PcoSingleResponse,
  PcoPerson,
  PcoPersonAttributes,
  PcoEmail,
  PcoEmailAttributes,
  PcoPhone,
  PcoPhoneAttributes,
  PcoAddress,
  PcoAddressAttributes,
  PcoHousehold,
  PcoPersonDetails,
} from "./types";

const PCO_BASE = "https://api.planningcenteronline.com/people/v2";

export class PcoClient {
  private readonly authHeader: string;

  constructor(appId: string, appSecret: string) {
    const encoded = btoa(`${appId}:${appSecret}`);
    this.authHeader = `Basic ${encoded}`;
  }

  // ── Core fetch ─────────────────────────────────────────────────────────────

  async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = path.startsWith("http") ? path : `${PCO_BASE}${path}`;
    const resp = await fetch(url, {
      ...options,
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        "X-PCO-API-Version": "2025-11-10",
        ...(options.headers ?? {}),
      },
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new PcoApiError(resp.status, body);
    }
    return resp.json() as Promise<T>;
  }

  // ── People ─────────────────────────────────────────────────────────────────

  /** Fetch a single page of people WITH sideloaded contact details.
   * Uses ?include=emails,phone_numbers,addresses to get all contacts in one
   * request per page instead of 3 extra API calls per person.
   */
  async getPeoplePageWithContacts(offset = 0, perPage = 100): Promise<{
    people: PcoPerson[];
    emailMap: Map<string, { address: string; location: string; primary: boolean }[]>;
    phoneMap: Map<string, { number: string; location: string; primary: boolean }[]>;
    addressMap: Map<string, { street: string | null; city: string | null; state: string | null; zip: string | null; location: string }[]>;
    hasMore: boolean;
    nextOffset: number;
  }> {
    const resp = await this.request<{
      data: PcoPerson[];
      included?: Array<{ type: string; id: string; attributes: Record<string, unknown> }>;
      meta: { next?: { offset: number } };
    }>(`/people?per_page=${perPage}&offset=${offset}&order=last_name&include=emails,phone_numbers,addresses`);

    // Index included resources by their id for quick lookup
    const includedById = new Map<string, { type: string; attributes: Record<string, unknown> }>();
    for (const inc of resp.included ?? []) {
      includedById.set(inc.id, { type: inc.type, attributes: inc.attributes });
    }

    const emailMap = new Map<string, { address: string; location: string; primary: boolean }[]>();
    const phoneMap = new Map<string, { number: string; location: string; primary: boolean }[]>();
    const addressMap = new Map<string, { street: string | null; city: string | null; state: string | null; zip: string | null; location: string }[]>();

    for (const person of resp.data) {
      const rels = (person as unknown as {
        relationships?: Record<string, { data?: Array<{ type: string; id: string }> | { type: string; id: string } | null }>;
      }).relationships ?? {};

      const relIds = (key: string): string[] => {
        const rel = rels[key]?.data;
        if (!rel) return [];
        if (Array.isArray(rel)) return rel.map((r) => r.id);
        return [rel.id];
      };

      emailMap.set(person.id, relIds("emails").flatMap((id) => {
        const r = includedById.get(id);
        if (!r || r.type !== "Email") return [];
        return [{ address: String(r.attributes.address ?? ""), location: String(r.attributes.location ?? "Home"), primary: Boolean(r.attributes.primary) }];
      }));

      phoneMap.set(person.id, relIds("phone_numbers").flatMap((id) => {
        const r = includedById.get(id);
        if (!r || r.type !== "PhoneNumber") return [];
        return [{ number: String(r.attributes.number ?? ""), location: String(r.attributes.location ?? "Home"), primary: Boolean(r.attributes.primary) }];
      }));

      addressMap.set(person.id, relIds("addresses").flatMap((id) => {
        const r = includedById.get(id);
        if (!r || r.type !== "Address") return [];
        return [{ street: (r.attributes.street as string | undefined) ?? null, city: (r.attributes.city as string | undefined) ?? null, state: (r.attributes.state as string | undefined) ?? null, zip: (r.attributes.zip as string | undefined) ?? null, location: String(r.attributes.location ?? "Home") }];
      }));
    }

    return {
      people: resp.data as PcoPerson[],
      emailMap,
      phoneMap,
      addressMap,
      hasMore: !!resp.meta.next,
      nextOffset: resp.meta.next?.offset ?? 0,
    };
  }

  /** Fetch a single page of people. Use `getAllPeople` for full sync. */
  async getPeoplePage(
    offset = 0,
    perPage = 100,
  ): Promise<PcoListResponse<PcoPersonAttributes>> {
    return this.request<PcoListResponse<PcoPersonAttributes>>(
      `/people?per_page=${perPage}&offset=${offset}&order=last_name`,
    );
  }

  /** Paginate through ALL people in the organisation. */
  async *getAllPeople(): AsyncGenerator<PcoPerson> {
    let offset = 0;
    const perPage = 100;

    while (true) {
      const page = await this.getPeoplePage(offset, perPage);
      for (const person of page.data) {
        yield person as PcoPerson;
      }
      if (!page.meta.next) break;
      offset = page.meta.next.offset;
    }
  }

  async getPerson(personId: string): Promise<PcoPerson> {
    const resp = await this.request<PcoSingleResponse<PcoPersonAttributes>>(
      `/people/${personId}`,
    );
    return resp.data as PcoPerson;
  }

  /** Search people by name, email, or phone. Returns up to 25 results. */
  async searchPeople(query: string): Promise<PcoPerson[]> {
    const encoded = encodeURIComponent(query);
    const resp = await this.request<PcoListResponse<PcoPersonAttributes>>(
      `/people?where[search_name_or_email_or_phone_number]=${encoded}&per_page=25`,
    );
    return resp.data as PcoPerson[];
  }

  /** Find a person by remote_id (SK individual ID). */
  async findByRemoteId(remoteId: number): Promise<PcoPerson | null> {
    const resp = await this.request<PcoListResponse<PcoPersonAttributes>>(
      `/people?where[remote_id]=${remoteId}&per_page=1`,
    );
    return (resp.data[0] as PcoPerson) ?? null;
  }

  async createPerson(
    attrs: Partial<PcoPersonAttributes>,
  ): Promise<PcoPerson> {
    const resp = await this.request<PcoSingleResponse<PcoPersonAttributes>>(
      "/people",
      {
        method: "POST",
        body: JSON.stringify({ data: { type: "Person", attributes: attrs } }),
      },
    );
    return resp.data as PcoPerson;
  }

  async updatePerson(
    personId: string,
    attrs: Partial<PcoPersonAttributes>,
  ): Promise<PcoPerson> {
    const resp = await this.request<PcoSingleResponse<PcoPersonAttributes>>(
      `/people/${personId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          data: { type: "Person", id: personId, attributes: attrs },
        }),
      },
    );
    return resp.data as PcoPerson;
  }

  // ── Emails ──────────────────────────────────────────────────────────────────

  async getEmails(personId: string): Promise<PcoEmail[]> {
    const resp = await this.request<PcoListResponse<PcoEmailAttributes>>(
      `/people/${personId}/emails?per_page=25`,
    );
    return resp.data as PcoEmail[];
  }

  async createEmail(
    personId: string,
    attrs: Partial<PcoEmailAttributes>,
  ): Promise<PcoEmail> {
    const resp = await this.request<PcoSingleResponse<PcoEmailAttributes>>(
      `/people/${personId}/emails`,
      {
        method: "POST",
        body: JSON.stringify({ data: { type: "Email", attributes: attrs } }),
      },
    );
    return resp.data as PcoEmail;
  }

  async updateEmail(
    personId: string,
    emailId: string,
    attrs: Partial<PcoEmailAttributes>,
  ): Promise<PcoEmail> {
    const resp = await this.request<PcoSingleResponse<PcoEmailAttributes>>(
      `/people/${personId}/emails/${emailId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          data: { type: "Email", id: emailId, attributes: attrs },
        }),
      },
    );
    return resp.data as PcoEmail;
  }

  // ── Phone numbers ───────────────────────────────────────────────────────────

  async getPhoneNumbers(personId: string): Promise<PcoPhone[]> {
    const resp = await this.request<PcoListResponse<import("./types").PcoPhoneAttributes>>(
      `/people/${personId}/phone_numbers?per_page=25`,
    );
    return resp.data as PcoPhone[];
  }

  async createPhoneNumber(
    personId: string,
    attrs: Partial<PcoPhoneAttributes>,
  ): Promise<PcoPhone> {
    const resp = await this.request<PcoSingleResponse<PcoPhoneAttributes>>(
      `/people/${personId}/phone_numbers`,
      {
        method: "POST",
        body: JSON.stringify({
          data: { type: "PhoneNumber", attributes: attrs },
        }),
      },
    );
    return resp.data as PcoPhone;
  }

  async updatePhoneNumber(
    personId: string,
    phoneId: string,
    attrs: Partial<PcoPhoneAttributes>,
  ): Promise<PcoPhone> {
    const resp = await this.request<PcoSingleResponse<PcoPhoneAttributes>>(
      `/people/${personId}/phone_numbers/${phoneId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          data: { type: "PhoneNumber", id: phoneId, attributes: attrs },
        }),
      },
    );
    return resp.data as PcoPhone;
  }

  // ── Addresses ───────────────────────────────────────────────────────────────

  async getAddresses(personId: string): Promise<PcoAddress[]> {
    const resp = await this.request<PcoListResponse<PcoAddressAttributes>>(
      `/people/${personId}/addresses?per_page=25`,
    );
    return resp.data as PcoAddress[];
  }

  async createAddress(
    personId: string,
    attrs: Partial<PcoAddressAttributes>,
  ): Promise<PcoAddress> {
    const resp = await this.request<PcoSingleResponse<PcoAddressAttributes>>(
      `/people/${personId}/addresses`,
      {
        method: "POST",
        body: JSON.stringify({ data: { type: "Address", attributes: attrs } }),
      },
    );
    return resp.data as PcoAddress;
  }

  async updateAddress(
    personId: string,
    addressId: string,
    attrs: Partial<PcoAddressAttributes>,
  ): Promise<PcoAddress> {
    const resp = await this.request<PcoSingleResponse<PcoAddressAttributes>>(
      `/people/${personId}/addresses/${addressId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          data: { type: "Address", id: addressId, attributes: attrs },
        }),
      },
    );
    return resp.data as PcoAddress;
  }

  // ── Households ──────────────────────────────────────────────────────────────

  async *getAllHouseholds(): AsyncGenerator<PcoHousehold> {
    let offset = 0;
    const perPage = 100;
    while (true) {
      const resp = await this.request<
        PcoListResponse<import("./types").PcoHouseholdAttributes>
      >(`/households?per_page=${perPage}&offset=${offset}`);
      for (const h of resp.data) {
        yield h as PcoHousehold;
      }
      if (!resp.meta.next) break;
      offset = resp.meta.next.offset;
    }
  }

  async getHouseholdMembers(householdId: string): Promise<PcoPerson[]> {
    const resp = await this.request<PcoListResponse<PcoPersonAttributes>>(
      `/households/${householdId}/people?per_page=25`,
    );
    return resp.data as PcoPerson[];
  }

  // ── Person details (all related records) ────────────────────────────────────

  async getPersonDetails(personId: string): Promise<PcoPersonDetails> {
    const [person, emails, phones, addresses] = await Promise.all([
      this.getPerson(personId),
      this.getEmails(personId),
      this.getPhoneNumbers(personId),
      this.getAddresses(personId),
    ]);

    // Fetch marital status
    let maritalStatus: string | null = null;
    try {
      const msResp = await this.request<{
        data: { type: string; attributes: { value: string } };
      }>(`/people/${personId}/marital_status`);
      maritalStatus = msResp.data?.attributes?.value ?? null;
    } catch {
      // not set
    }

    return { person, emails, phones, addresses, maritalStatus };
  }
}

// ── Error type ────────────────────────────────────────────────────────────────

export class PcoApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly body: string,
  ) {
    super(`PCO API error ${statusCode}: ${body}`);
    this.name = "PcoApiError";
  }
}
